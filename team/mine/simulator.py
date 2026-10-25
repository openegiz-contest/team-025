#!/usr/bin/env python3
"""Discrete-event simulator for the team's open-pit section (SimPy).

Haul cycle per truck: queue at its assigned excavator -> load (bucket
passes) -> haul to crusher (ore) or dump (waste) via the road graph ->
dump -> refuel if low -> haul back empty -> repeat. Ore trucks route
face -> junction -> crusher, picking whichever main road segment
(road-main-a primary, road-main-b backup) is open; closing both blocks
that flow, closing one just lengthens the cycle (see
../docs/design-twins.md section 5).

Control loop, and who owns what:

  * `attributes` are the operator's. This process only ever reads them:
    `closed` on a road, `forced_down` on an excavator/truck/crusher,
    `assigned_excavator` on a truck.
  * `features` are this process's. It is the only writer of every twin's
    descriptive `state` and the rest of the telemetry.

That split is load-bearing, not tidiness. Publishing is a Ditto `modify`
on `/features`, which replaces every feature of a twin at once, so a
command that lived in features could be flattened by a publish built
microseconds before the command landed -- and lost for good, because the
next poll then read back this process's own stale echo. A `/features`
modify cannot touch attributes. See DittoPoller.

Commands are polled from Ditto's REST API once per tick, in a single bulk
request immediately before that same tick's publish, and read fresh again
at each truck's safe decision points. Deliberately a poll loop, not a live
Ditto event subscription -- simpler to get right, and a couple of seconds
of latency is fine for a dispatch demo. See design-twins.md section 5 for
the trade-off.

All physics constants are in constants.py, each tagged SOURCED or
ASSUMPTION. This file does not hardcode any of its own.

Publishes only via MQTT, Ditto protocol `modify` on /features, same
contract as examples/mine/simulator.py.
"""

import argparse
import base64
import json
import logging
import os
import random
import signal
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import deque
from dataclasses import dataclass, field

import paho.mqtt.client as mqtt
import simpy
import simpy.rt

import constants as c

TOPIC_PREFIX = "telemetry"
POLL_WAIT_S = 30.0  # simulated seconds between re-checks while a truck is blocked

EXCAVATOR_INFO = {
    "excavator-01": {"face": "face-ore-01", "access_road": "road-face1", "is_waste": False},
    "excavator-02": {"face": "face-ore-02", "access_road": "road-face2", "is_waste": False},
    "excavator-03": {"face": "face-waste-01", "access_road": "road-waste", "is_waste": True},
}
MAIN_ROAD_CANDIDATES = ["road-main-a", "road-main-b"]

log = logging.getLogger("mine")


# ---------------------------------------------------------------------------
# State containers (plain data; SimPy processes below mutate them)
# ---------------------------------------------------------------------------

@dataclass
class Excavator:
    id: str
    state: str = "idle"
    forced_down: bool = False
    tonnes_loaded_shift: float = 0.0
    passes_total: int = 0
    repair_eta: float = -1.0
    repair_forced: bool = False  # this outage was ordered, not random (see reliability_process)
    resource: object = None

    def features(self, trucks_assigned):
        return {
            "state": {"value": self.state},
            "tonnes_loaded_shift": {"value": round(self.tonnes_loaded_shift, 1), "unit": "t"},
            "passes_total": {"value": self.passes_total, "unit": "passes"},
            "trucks_assigned": {"value": trucks_assigned, "unit": "trucks"},
        }


@dataclass
class Truck:
    id: str
    assigned_excavator: str
    state: str = "queued_at_excavator"
    payload_t: float = 0.0
    grade: float = 0.0
    fuel_pct: float = 100.0
    forced_down: bool = False
    trips_total: int = 0
    leg_start_t: float = 0.0
    leg_duration_s: float = 0.0
    leg_distance_km: float = 0.0
    leg_speed_kmh: float = 0.0
    current_road_id: str = ""

    def snapshot(self, now):
        if self.state in ("hauling", "returning") and self.leg_duration_s > 0:
            frac = min(1.0, (now - self.leg_start_t) / self.leg_duration_s)
            position = round(frac * self.leg_distance_km, 3)
            speed = round(self.leg_speed_kmh, 1)
        else:
            position, speed = 0.0, 0.0
        return {
            "state": {"value": self.state},
            "payload_t": {"value": round(self.payload_t, 1), "unit": "t"},
            "speed_kmh": {"value": speed, "unit": "km/h"},
            "route_position_km": {"value": position, "unit": "km"},
            # Which road twin this position is measured along -- the viewer
            # needs this (plus that road's from/to attributes) to place the
            # truck in 3D; "" when not on any leg (loading/dumping/down/...).
            "current_road": {"value": self.current_road_id if self.state in ("hauling", "returning") else ""},
            "fuel_pct": {"value": round(self.fuel_pct, 1), "unit": "%"},
            # The excavator this truck is *actually* working to, which is not
            # the same thing as `attributes.assigned_excavator`: that one is
            # the dispatcher's order, and it only takes effect at the truck's
            # next safe decision point. Grafana's fleet table reads this one.
            "assigned_excavator": {"value": self.assigned_excavator},
            "trips_total": {"value": self.trips_total, "unit": "trips"},
        }


@dataclass
class Road:
    id: str
    length_km: float
    avg_grade_pct: float
    state: str = "open"
    #: Declared direction is always the loaded direction (face -> junction ->
    #: crusher, face -> dump), so a loaded truck always climbs and an empty
    #: one always descends. That holds because every face is below the
    #: crusher pad and the dump is above it.
    climbs_loaded: bool = True

    def features(self, trucks_on_road):
        return {"state": {"value": self.state}, "trucks_on_road": {"value": trucks_on_road, "unit": "trucks"}}


@dataclass
class Crusher:
    state: str = "idle"
    forced_down: bool = False
    tonnes_shift: float = 0.0
    repair_eta: float = -1.0
    repair_forced: bool = False  # this outage was ordered, not random (see reliability_process)
    window_log: list = field(default_factory=list)  # (sim_time, tonnes, grade), last CRUSHER_WINDOW_S
    hopper_t: float = 0.0     # tipped but not yet "processed" -- smooths bursts, caps throughput_tph
    hopper_grade: float = 0.0

    def hopper_room(self):
        """Tonnes the dump pocket can still take."""
        return max(0.0, c.CRUSHER_HOPPER_CAPACITY_T - self.hopper_t)

    def hopper_add(self, tonnes, grade):
        """Trucks (direct dump) and stockpile reclaim both land here, not in
        `add()` directly -- draining this at CRUSHER_TARGET_TPH (see
        crusher_drain_process) is what stops reported throughput_tph from
        exceeding the crusher's own sourced rated capacity.

        Bounded by the pocket's capacity: anything over it is refused and
        returned, so no tonne can disappear in here. Callers must place what
        comes back (a truck tips it on the stockpile instead).
        """
        accepted = min(tonnes, self.hopper_room())
        new_total = self.hopper_t + accepted
        if new_total > 0:
            self.hopper_grade = (self.hopper_grade * self.hopper_t + grade * accepted) / new_total
        self.hopper_t = new_total
        return tonnes - accepted

    def add(self, now, tonnes, grade):
        self.window_log.append((now, tonnes, grade))
        self.tonnes_shift += tonnes

    def windowed(self, now, window_s=3600.0):
        self.window_log = [e for e in self.window_log if now - e[0] <= window_s]
        tonnes = sum(t for _, t, _ in self.window_log)
        grade_tonnes = sum(t * g for _, t, g in self.window_log)
        window_hours = min(now, window_s) / 3600.0 or 1.0 / 3600.0
        tph = tonnes / window_hours if window_hours > 0 else 0.0
        grade = grade_tonnes / tonnes if tonnes > 0 else 0.0
        return tph, grade

    def features(self, now):
        tph, grade = self.windowed(now)
        active_recently = any(now - t <= 90 for t, _, _ in self.window_log)
        state = "down" if self.state == "down" else ("crushing" if active_recently else "idle")
        return {
            "state": {"value": state},
            "throughput_tph": {"value": round(tph, 1), "unit": "t/h"},
            "feed_grade": {"value": round(grade, 3), "unit": "% Cu"},
            "tonnes_shift": {"value": round(self.tonnes_shift, 1), "unit": "t"},
            # The dump pocket is real tonnage with real dynamics, so it is
            # published rather than left as a hidden variable: a full pocket
            # is the reason trucks start tipping on the stockpile.
            "hopper_t": {"value": round(self.hopper_t, 1), "unit": "t"},
        }, state


@dataclass
class Stockpile:
    tonnes_current: float = 0.0
    avg_grade: float = 0.0
    last_reclaim_tph: float = 0.0

    def add(self, tonnes, grade):
        new_total = self.tonnes_current + tonnes
        if new_total > 0:
            self.avg_grade = (self.avg_grade * self.tonnes_current + grade * tonnes) / new_total
        self.tonnes_current = new_total

    def remove(self, tonnes):
        self.tonnes_current = max(0.0, self.tonnes_current - tonnes)
        if self.tonnes_current <= 0:
            self.avg_grade = 0.0

    def features(self):
        return {
            "tonnes_current": {"value": round(self.tonnes_current, 1), "unit": "t"},
            "avg_grade": {"value": round(self.avg_grade, 3), "unit": "% Cu"},
            "reclaim_tph": {"value": round(self.last_reclaim_tph, 1), "unit": "t/h"},
        }


class Section:
    def __init__(self, seed):
        self.rng = random.Random(seed)
        self.face_grade = {"face-ore-01": c.FACE_ORE_01_GRADE_PCT, "face-ore-02": c.FACE_ORE_02_GRADE_PCT}
        self.excavators = {eid: Excavator(eid) for eid in EXCAVATOR_INFO}
        self.roads = {
            rid: Road(rid, c.ROAD_LENGTHS_KM[rid], c.road_avg_grade_pct(rid))
            for rid in c.ROAD_EDGES
        }
        ore_assign = c.initial_truck_assignment()
        self.trucks = {
            f"truck-{i:02d}": Truck(f"truck-{i:02d}", ore_assign[i - 1]) for i in range(1, c.FLEET_SIZE + 1)
        }
        self.crusher = Crusher()
        self.stockpile = Stockpile()
        self.dump_tonnes_current = 0.0
        self.dump_tonnes_shift = 0.0
        # Broken tonnage standing in front of each shovel. It only ever goes
        # down: a face that is mined out stops, which is what stops a
        # dispatcher from parking the whole fleet on the richest bench.
        self.face_reserves = dict(c.FACE_RESERVES_T)
        self.face_mined_shift = {fid: 0.0 for fid in c.FACE_RESERVES_T}
        self.junction_passes_shift = 0
        # (arrival_time, tonnes): what is riding the belt right now. A bucket
        # leaves the crusher at `now` and reaches the plant one transit later.
        self.conveyor_belt = deque()
        self.conveyor_tonnes_shift = 0.0
        self.shift_tonnes_grade_sum = 0.0  # cumulative, whole shift (unlike crusher.window_log)
        self.shift_number = 1
        self.shift_start_t = 0.0
        self.last_snapshot_t = 0.0

    def start_new_shift(self, now):
        """Roll the per-shift counters over at the end of a shift.

        Everything that is physically still there -- the stockpile, the
        tonnage already in the dump, each truck's lifetime trip count --
        carries over; only what the plan is measured against resets.
        """
        self.shift_number += 1
        self.shift_start_t = now
        self.crusher.tonnes_shift = 0.0
        self.shift_tonnes_grade_sum = 0.0
        self.dump_tonnes_shift = 0.0
        self.junction_passes_shift = 0
        self.conveyor_tonnes_shift = 0.0
        for fid in self.face_mined_shift:
            self.face_mined_shift[fid] = 0.0
        for exc in self.excavators.values():
            exc.tonnes_loaded_shift = 0.0
        log.info("shift %s started at sim %.0f min", self.shift_number, now / 60)

    # -- shared helpers used by truck processes ------------------------------
    def choose_open_road(self, candidates):
        for rid in candidates:
            if self.roads[rid].state != "closed":
                return rid
        return None

    def face_has_reserves(self, face_id, tonnes):
        return self.face_reserves.get(face_id, 0.0) >= tonnes

    def face_take(self, face_id, tonnes):
        """Move broken tonnage off the face and onto a truck."""
        self.face_reserves[face_id] = max(0.0, self.face_reserves[face_id] - tonnes)
        self.face_mined_shift[face_id] += tonnes

    def conveyor_step(self, now, dt_s, crusher_tph):
        """Carry the crusher's discharge to the plant, one transit time later.

        Returns (tonnes delivered this step, tonnes currently on the belt).
        The belt is a travelling queue, not a pipe: what the crusher loads now
        arrives CONVEYOR_TRANSIT_S from now, so the belt goes on running --
        and the plant goes on being fed -- for a full transit after the
        crusher stops, and stays empty for a transit after it restarts.
        Loading is clipped at the belt's rating, which is what makes the belt
        its own limit rather than a mirror of the crusher."""
        if dt_s <= 0:
            return 0.0, sum(t for _, t in self.conveyor_belt)
        loaded_t = min(crusher_tph, c.CONVEYOR_RATED_TPH) * dt_s / 3600.0
        if loaded_t > 0:
            self.conveyor_belt.append((now + c.CONVEYOR_TRANSIT_S, loaded_t))
        delivered = 0.0
        while self.conveyor_belt and self.conveyor_belt[0][0] <= now:
            delivered += self.conveyor_belt.popleft()[1]
        self.conveyor_tonnes_shift += delivered
        return delivered / (dt_s / 3600.0), sum(t for _, t in self.conveyor_belt)

    def crusher_add(self, now, tonnes, grade):
        self.crusher.add(now, tonnes, grade)
        self.shift_tonnes_grade_sum += tonnes * grade

    def shift_tonnes_actual(self):
        return self.crusher.tonnes_shift

    def shift_grade_actual(self):
        return self.shift_tonnes_grade_sum / self.crusher.tonnes_shift if self.crusher.tonnes_shift else 0.0


# ---------------------------------------------------------------------------
# SimPy processes
# ---------------------------------------------------------------------------

def haul_leg(env, section, truck, road_id, loaded):
    road = section.roads[road_id]
    base_speed = c.SPEED_LOADED_KMH_BASE if loaded else c.SPEED_EMPTY_KMH_BASE
    # ASSUMPTION: haul speed derates linearly with grade, and only uphill.
    # A loaded truck climbing out of a bench is rimpull-limited, so the ramp
    # out of the deeper bench costs real minutes; coming back down it is
    # brake- and speed-limit-bound, which the flat SPEED_EMPTY base already
    # represents. GRADE_SPEED_PENALTY is set so the steepest ramp here runs
    # at roughly 70% of flat-haul speed.
    climbing = loaded == road.climbs_loaded
    grade_factor = (max(0.5, 1.0 - road.avg_grade_pct * c.GRADE_SPEED_PENALTY)
                    if climbing else 1.0)
    speed = min(c.TRUCK_MAX_SPEED_KMH, base_speed * grade_factor * section.rng.uniform(0.9, 1.1))
    duration_s = (road.length_km / speed) * 3600.0 / c.JOB_EFFICIENCY
    truck.state = "hauling" if loaded else "returning"
    truck.current_road_id = road_id
    truck.leg_start_t = env.now
    truck.leg_duration_s = duration_s
    truck.leg_distance_km = road.length_km
    truck.leg_speed_kmh = speed
    yield env.timeout(duration_s)
    fuel_rate = c.FUEL_LPKM_LOADED if loaded else c.FUEL_LPKM_EMPTY
    truck.fuel_pct = max(0.0, truck.fuel_pct - fuel_rate * road.length_km / c.TRUCK_TANK_L * 100.0)


def truck_process(env, section, truck_id):
    truck = section.trucks[truck_id]
    while True:
        while truck.forced_down:
            truck.state = "down"
            yield env.timeout(POLL_WAIT_S)

        exc_id = truck.assigned_excavator
        exc = section.excavators[exc_id]
        info = EXCAVATOR_INFO[exc_id]

        access_road = section.choose_open_road([info["access_road"]])
        while access_road is None or exc.forced_down:
            truck.state = "blocked_road" if access_road is None else "waiting_excavator_down"
            yield env.timeout(POLL_WAIT_S)
            exc_id = truck.assigned_excavator  # dispatcher may have reassigned while we waited
            exc, info = section.excavators[exc_id], EXCAVATOR_INFO[exc_id]
            access_road = section.choose_open_road([info["access_road"]])

        while not section.face_has_reserves(info["face"], c.TRUCK_CAPACITY_T):
            # The bench in front of this shovel is mined out. Nothing to load
            # until a dispatcher sends the truck to a face that still has
            # broken stock.
            truck.state = "face_depleted"
            yield env.timeout(POLL_WAIT_S)
            exc_id = truck.assigned_excavator
            exc, info = section.excavators[exc_id], EXCAVATOR_INFO[exc_id]

        with exc.resource.request() as req:
            truck.state = "queued_at_excavator"
            yield req
            truck.state = "loading"
            exc.state = "loading"
            load_s = c.EXCAVATOR_PASSES_TO_FILL * c.EXCAVATOR_CYCLE_S * section.rng.uniform(0.9, 1.1)
            yield env.timeout(load_s)
            truck.payload_t = c.TRUCK_CAPACITY_T
            truck.grade = section.face_grade.get(info["face"], 0.0)
            section.face_take(info["face"], c.TRUCK_CAPACITY_T)
            exc.tonnes_loaded_shift += c.TRUCK_CAPACITY_T
            exc.passes_total += c.EXCAVATOR_PASSES_TO_FILL
            exc.state = "idle"

        if info["is_waste"]:
            road_id = section.choose_open_road(["road-waste"])
            while road_id is None:
                truck.state = "blocked_road"
                yield env.timeout(POLL_WAIT_S)
                road_id = section.choose_open_road(["road-waste"])
            yield from haul_leg(env, section, truck, road_id, loaded=True)
            truck.state = "dumping"
            yield env.timeout(c.SPOT_SECONDS + c.DUMP_SECONDS)
            section.dump_tonnes_current += truck.payload_t
            section.dump_tonnes_shift += truck.payload_t
        else:
            face_road = section.choose_open_road([info["access_road"]])
            yield from haul_leg(env, section, truck, face_road, loaded=True)
            main_id = section.choose_open_road(MAIN_ROAD_CANDIDATES)
            while main_id is None:
                truck.state = "blocked_at_junction"
                yield env.timeout(POLL_WAIT_S)
                main_id = section.choose_open_road(MAIN_ROAD_CANDIDATES)
            section.junction_passes_shift += 1
            yield from haul_leg(env, section, truck, main_id, loaded=True)
            truck.state = "queued_at_crusher"
            yield env.timeout(c.SPOT_SECONDS)
            # Straight into the crusher's dump pocket when there is room for
            # the whole load; otherwise onto the stockpile, which is what the
            # pocket being full physically means. A part load is never split
            # between the two -- a truck tips once, somewhere.
            crusher_takes = (
                section.crusher.state != "down"
                and section.crusher.hopper_room() >= truck.payload_t
            )
            if crusher_takes:
                truck.state = "dumping"
                yield env.timeout(c.DUMP_SECONDS)
                section.crusher.hopper_add(truck.payload_t, truck.grade)
            else:
                while section.stockpile.tonnes_current >= c.STOCKPILE_CAPACITY_T:
                    truck.state = "queued_stockpile_full"
                    yield env.timeout(POLL_WAIT_S)
                    # The pocket may have drained while the truck waited.
                    if (section.crusher.state != "down"
                            and section.crusher.hopper_room() >= truck.payload_t):
                        break
                truck.state = "dumping"
                yield env.timeout(c.DUMP_SECONDS)
                if (section.crusher.state != "down"
                        and section.crusher.hopper_room() >= truck.payload_t):
                    section.crusher.hopper_add(truck.payload_t, truck.grade)
                else:
                    section.stockpile.add(truck.payload_t, truck.grade)

        truck.trips_total += 1
        truck.payload_t = 0.0

        if truck.fuel_pct < c.REFUEL_BELOW_PCT:
            truck.state = "refueling"
            yield env.timeout(c.REFUEL_SECONDS)
            truck.fuel_pct = 100.0

        if info["is_waste"]:
            road_id = section.choose_open_road(["road-waste"])
            while road_id is None:
                truck.state = "blocked_road"
                yield env.timeout(POLL_WAIT_S)
                road_id = section.choose_open_road(["road-waste"])
            yield from haul_leg(env, section, truck, road_id, loaded=False)
        else:
            main_id = section.choose_open_road(MAIN_ROAD_CANDIDATES)
            while main_id is None:
                truck.state = "blocked_at_junction"
                yield env.timeout(POLL_WAIT_S)
                main_id = section.choose_open_road(MAIN_ROAD_CANDIDATES)
            yield from haul_leg(env, section, truck, main_id, loaded=False)
            face_road = section.choose_open_road([info["access_road"]])
            while face_road is None:
                truck.state = "blocked_road"
                yield env.timeout(POLL_WAIT_S)
                face_road = section.choose_open_road([info["access_road"]])
            yield from haul_leg(env, section, truck, face_road, loaded=False)


def reliability_process(env, section, unit, mtbf_h, mttr_h, idle_state):
    """Shared failure/repair loop for an excavator or the crusher.

    `forced_down` (operator, via Ditto) and a light random background
    failure (ASSUMPTION-grade MTBF, see constants.py) both start the same
    MTTR repair timer; the simulator clears the failure itself when the
    timer elapses, whether the failure was triggered manually or at
    random -- so a what-if demo self-heals instead of staying broken.

    A failure the operator asked for is also cancelled the moment they take
    the request back, without waiting out the repair timer. Otherwise the
    "restore" button does nothing visible for the ~4 simulated hours of
    MTTR, which is not a cancellable scenario in any useful sense. A
    *random* failure still has to run its repair out -- the operator did
    not cause it and cannot wish it away.
    """
    while True:
        yield env.timeout(POLL_WAIT_S)
        if unit.state == "down":
            if (unit.repair_forced and not unit.forced_down) or env.now >= unit.repair_eta:
                unit.state = idle_state
                unit.repair_forced = False
            continue
        random_trigger = section.rng.random() < (POLL_WAIT_S / (mtbf_h * 3600.0))
        if unit.forced_down or random_trigger:
            unit.state = "down"
            unit.repair_forced = unit.forced_down
            mttr_s = max(120.0, section.rng.expovariate(1.0 / (mttr_h * 3600.0)))
            unit.repair_eta = env.now + mttr_s


def face_grade_process(env, section):
    """Light noise around each ore face's calibrated grade (design-twins.md 3.2);
    bounded so the two faces stay meaningfully different."""
    targets = {"face-ore-01": c.FACE_ORE_01_GRADE_PCT, "face-ore-02": c.FACE_ORE_02_GRADE_PCT}
    while True:
        yield env.timeout(60.0)
        for face_id, target in targets.items():
            g = section.face_grade[face_id] + section.rng.gauss(0, 0.01)
            section.face_grade[face_id] = min(target * 1.15, max(target * 0.85, g))


def shift_process(env, section):
    """End one shift, start the next, forever.

    Without this the shift plan only ever counts up: left running, the Stand
    settles on something like "260% of plan, 0 minutes remaining", which is
    not a dispatcher's screen, it is a counter that ran off the end of its
    scale. At the default 10x speedup a 12-hour shift turns over every ~72
    real minutes.
    """
    while True:
        yield env.timeout(c.SHIFT_HOURS * 3600.0)
        section.start_new_shift(env.now)


def stockpile_reclaim_process(env, section):
    tick_s = 120.0
    while True:
        yield env.timeout(tick_s)
        # Reclaim only what the pocket can actually take: the feeder cannot
        # push ore into a full crusher, and anything it "reclaimed" beyond
        # that would leave the stockpile without arriving anywhere.
        room = section.crusher.hopper_room()
        if section.crusher.state != "down" and section.stockpile.tonnes_current > 0 and room > 0:
            amount = min(
                section.stockpile.tonnes_current,
                c.STOCKPILE_RECLAIM_TPH * (tick_s / 3600.0),
                room,
            )
            grade = section.stockpile.avg_grade
            section.stockpile.remove(amount)
            section.stockpile.last_reclaim_tph = amount / (tick_s / 3600.0)
            section.crusher.hopper_add(amount, grade)
        else:
            section.stockpile.last_reclaim_tph = 0.0


def crusher_drain_process(env, section):
    """Drains the hopper into the processed log at CRUSHER_TARGET_TPH --
    the single place that caps reported throughput at the crusher's own
    rated capacity, whether the tonnage came from a direct dump or stockpile
    reclaim (see constants.CRUSHER_TARGET_TPH)."""
    tick_s = 60.0
    while True:
        yield env.timeout(tick_s)
        cr = section.crusher
        if cr.state == "down" or cr.hopper_t <= 0:
            continue
        amount = min(cr.hopper_t, c.CRUSHER_TARGET_TPH * (tick_s / 3600.0))
        grade = cr.hopper_grade
        cr.hopper_t -= amount
        if cr.hopper_t <= 0:
            cr.hopper_t, cr.hopper_grade = 0.0, 0.0
        section.crusher_add(env.now, amount, grade)


# ---------------------------------------------------------------------------
# Ditto REST polling (control features only -- see module docstring)
# ---------------------------------------------------------------------------

class DittoPoller:
    """Reads the operator's commands back out of Ditto.

    Commands live in `attributes` and never in `features`, and that is the
    whole point. This process publishes a Ditto `modify` on `/features`,
    which replaces *every* feature of a twin at once. An operator-written
    value that also lived in features could therefore be flattened by a
    publish whose snapshot was built just before that write landed -- and
    since the next poll then reads back our own stale echo, the command was
    lost for good, with no error anywhere. Confirmed live: closing a road
    silently failed roughly one try in four.

    A `/features` modify cannot touch attributes, so a command written there
    always survives. The worst case is now that it takes effect one tick
    later instead of never.
    """

    def __init__(self, base_url, user, password, timeout_s=5.0):
        self.base_url = base_url.rstrip("/")
        self.auth = "Basic " + base64.b64encode(f"{user}:{password}".encode()).decode()
        self.timeout_s = timeout_s

    def get_attributes(self, thing_ids):
        """{short thing id: attributes dict} for many twins in ONE request.

        One request rather than one per twin: 26 sequential round trips every
        couple of seconds is both needless load and a needlessly wide spread
        of read times across a single logical poll.
        """
        ids = ",".join(f"{c.NAMESPACE}:{tid}" for tid in thing_ids)
        url = f"{self.base_url}/api/2/things?ids={urllib.parse.quote(ids)}&fields=thingId,attributes"
        req = urllib.request.Request(url, headers={"Authorization": self.auth})
        with urllib.request.urlopen(req, timeout=self.timeout_s) as resp:
            things = json.loads(resp.read())
        return {
            thing.get("thingId", "").split(":", 1)[-1]: (thing.get("attributes") or {})
            for thing in things
        }

    def poll_into(self, section):
        ids = list(section.roads) + list(section.excavators) + list(section.trucks) + ["crusher-01"]
        try:
            attrs = self.get_attributes(ids)
        except (urllib.error.URLError, TimeoutError, ValueError, OSError) as err:
            # Nothing is applied this tick; the next one retries in --interval
            # seconds. Commands sit in Ditto until then, they are not lost.
            log.debug("control poll failed: %s", err)
            return

        for road_id, road in section.roads.items():
            if road_id in attrs:
                road.state = "closed" if attrs[road_id].get("closed") else "open"

        for exc_id, exc in section.excavators.items():
            if exc_id in attrs:
                exc.forced_down = bool(attrs[exc_id].get("forced_down", False))

        if "crusher-01" in attrs:
            section.crusher.forced_down = bool(attrs["crusher-01"].get("forced_down", False))

        for truck_id, truck in section.trucks.items():
            attributes = attrs.get(truck_id)
            if attributes is None:
                continue
            truck.forced_down = bool(attributes.get("forced_down", False))
            assigned = attributes.get("assigned_excavator")
            if assigned in EXCAVATOR_INFO:
                truck.assigned_excavator = assigned


# ---------------------------------------------------------------------------
# Publishing
# ---------------------------------------------------------------------------

def ditto_modify_features(name, features):
    """A Ditto protocol command replacing all features of one twin.

    Each feature needs its own `properties` wrapper -- Ditto's Feature
    schema only recognizes `properties`/`desiredProperties`/`definition`,
    so a bare `{"value": ...}` is silently dropped (confirmed against a
    live Ditto: every feature came back as `{}` before this wrapping was
    added -- see team/docs/design-twins.md section 7)."""
    return {
        "topic": f"{c.NAMESPACE}/{name}/things/twin/commands/modify",
        "path": "/features",
        "value": {feature: {"properties": props} for feature, props in features.items()},
    }


def build_snapshot(section, now, speedup):
    things = {}

    trucks_per_excavator = {eid: 0 for eid in section.excavators}
    trucks_per_road = {rid: 0 for rid in section.roads}
    trucks_at_junction = 0
    trucks_refueling = 0
    for truck in section.trucks.values():
        trucks_per_excavator[truck.assigned_excavator] = trucks_per_excavator.get(truck.assigned_excavator, 0) + 1
        if truck.state in ("hauling", "returning") and truck.current_road_id:
            trucks_per_road[truck.current_road_id] = trucks_per_road.get(truck.current_road_id, 0) + 1
        if truck.state == "blocked_at_junction":
            trucks_at_junction += 1
        if truck.state == "refueling":
            trucks_refueling += 1
        things[truck.id] = truck.snapshot(now)

    for eid, exc in section.excavators.items():
        things[eid] = exc.features(trucks_per_excavator.get(eid, 0))

    for rid, road in section.roads.items():
        things[rid] = road.features(trucks_per_road.get(rid, 0))

    face_road = {"face-ore-01": "road-face1", "face-ore-02": "road-face2", "face-waste-01": "road-waste"}
    for face_id, road_id in face_road.items():
        reserves = section.face_reserves.get(face_id, 0.0)
        if reserves < c.TRUCK_CAPACITY_T:
            state = "depleted"
        elif section.roads[road_id].state == "closed":
            state = "blocked"
        else:
            state = "active"
        feats = {
            "state": {"value": state},
            "reserves_t": {"value": round(reserves, 1), "unit": "t"},
            "tonnes_mined_shift": {"value": round(section.face_mined_shift.get(face_id, 0.0), 1), "unit": "t"},
        }
        if face_id in section.face_grade:
            feats["grade"] = {"value": round(section.face_grade[face_id], 3), "unit": "% Cu"}
        things[face_id] = feats

    # A bench reports the work done on the face it carries, so the vertical
    # structure of the pit is visible in the twins and not only in the scene.
    for bench_id, (_, face_id, _) in c.BENCHES.items():
        things[bench_id] = {
            "state": things[face_id]["state"],
            "tonnes_mined_shift": things[face_id]["tonnes_mined_shift"],
        }

    main_open = section.choose_open_road(MAIN_ROAD_CANDIDATES)
    things["junction-01"] = {
        "state": {"value": "blocked" if main_open is None
                  else ("congested" if trucks_at_junction else "clear")},
        "trucks_at_junction": {"value": trucks_at_junction, "unit": "trucks"},
        "trucks_passed_shift": {"value": section.junction_passes_shift, "unit": "trucks"},
        # Which main the junction is currently routing ore onto -- the
        # visible consequence of closing one of them.
        "route_main": {"value": main_open or ""},
    }

    crusher_feats, crusher_state = section.crusher.features(now)
    things["crusher-01"] = crusher_feats
    belt_tph, on_belt_t = section.conveyor_step(
        now, now - section.last_snapshot_t, crusher_feats["throughput_tph"]["value"])
    section.last_snapshot_t = now
    things["conveyor-01"] = {
        "state": {"value": "running" if on_belt_t > 0 else "stopped"},
        "throughput_tph": {"value": round(belt_tph, 1), "unit": "t/h"},
        "load_pct": {"value": round(100.0 * belt_tph / c.CONVEYOR_RATED_TPH, 1), "unit": "%"},
        "on_belt_t": {"value": round(on_belt_t, 1), "unit": "t"},
        "tonnes_shift": {"value": round(section.conveyor_tonnes_shift, 1), "unit": "t"},
    }
    things["stockpile-01"] = section.stockpile.features()
    things["dump-01"] = {
        "tonnes_current": {"value": round(section.dump_tonnes_current, 1), "unit": "t"},
        "tonnes_shift": {"value": round(section.dump_tonnes_shift, 1), "unit": "t"},
    }
    things["fuel-01"] = {
        "state": {"value": "serving" if trucks_refueling else "idle"},
        "trucks_queued": {"value": trucks_refueling, "unit": "trucks"},
    }
    units_down = sum(1 for e in section.excavators.values() if e.state == "down")
    units_down += 1 if section.crusher.state == "down" else 0
    units_down += sum(1 for t in section.trucks.values() if t.state == "down")
    things["repair-01"] = {
        "units_in_repair": {"value": units_down, "unit": "units"},
        "state": {"value": "busy" if units_down else "idle"},
    }

    active_trucks = sum(1 for t in section.trucks.values() if t.state != "down")
    things["section-01"] = {
        "tonnes_to_crusher_shift": crusher_feats["tonnes_shift"],
        "feed_grade": crusher_feats["feed_grade"],
        "trucks_active": {"value": active_trucks, "unit": "trucks"},
        # Lets the viewer dead-reckon truck motion between SSE ticks instead
        # of only redrawing once per publish (see app.js updateTruckMotion).
        "sim_speedup": {"value": speedup, "unit": "simulated s / real s"},
    }
    tonnes_actual = section.shift_tonnes_actual()
    elapsed_min = (now - section.shift_start_t) / 60.0
    things["shift-01"] = {
        "plan_tonnes": {"value": round(c.PLAN_TONNES_SHIFT, 1), "unit": "t"},
        "plan_grade_min": {"value": c.PLAN_GRADE_MIN_PCT, "unit": "% Cu"},
        "plan_stripping_ratio": {"value": c.PLAN_STRIPPING_RATIO, "unit": "t/t"},
        "lom_stripping_ratio": {"value": c.LOM_STRIPPING_RATIO, "unit": "t/t"},
        "waste_tonnes_actual": {"value": round(section.dump_tonnes_shift, 1), "unit": "t"},
        "stripping_ratio_actual": {
            "value": round(section.dump_tonnes_shift / tonnes_actual, 2) if tonnes_actual else 0.0,
            "unit": "t/t",
        },
        "tonnes_actual": {"value": round(tonnes_actual, 1), "unit": "t"},
        "grade_actual": {"value": round(section.shift_grade_actual(), 3), "unit": "% Cu"},
        "time_remaining_min": {"value": round(max(0.0, c.SHIFT_HOURS * 60 - elapsed_min), 1), "unit": "min"},
        "plan_completion_pct": {"value": round(100.0 * tonnes_actual / c.PLAN_TONNES_SHIFT, 1), "unit": "%"},
        "shift_number": {"value": section.shift_number},
    }
    return things


def publisher_process(env, section, client, poller, interval_sim_s, args):
    """Poll-then-publish, both in the same tick of the same process.

    They used to be two independent periodic processes, which raced badly:
    a publish firing between an operator's write and the next poll
    overwrote that write, and the poll then read back its own stale echo.
    One timer narrows that window to the gap between this tick's poll and
    this tick's publish; keeping the operator's commands in `attributes`,
    which a `/features` publish cannot reach, closes it altogether (see
    DittoPoller and team/docs/design-twins.md section 7)."""
    published = 0
    while True:
        yield env.timeout(interval_sim_s)
        if poller:
            poller.poll_into(section)
        snapshot = build_snapshot(section, env.now, args.speedup)
        for name, features in snapshot.items():
            message = json.dumps(ditto_modify_features(name, features))
            if client:
                client.publish(f"{TOPIC_PREFIX}/{name}", message, qos=0)
            else:
                print(message)
        published += 1
        if published % 15 == 0:
            shift = snapshot["shift-01"]
            log.info(
                "sim %5.0f min | crusher %.1f t/h, %.3f %% Cu, %.0f t total | plan %.0f%% | trucks active %s",
                env.now / 60, snapshot["crusher-01"]["throughput_tph"]["value"],
                snapshot["crusher-01"]["feed_grade"]["value"], snapshot["crusher-01"]["tonnes_shift"]["value"],
                shift["plan_completion_pct"]["value"], snapshot["section-01"]["trucks_active"]["value"],
            )
        if args.steps and published >= args.steps:
            raise StopSimulation


class StopSimulation(Exception):
    pass


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--mqtt-host", default=os.environ.get("MQTT_HOST", "localhost"))
    p.add_argument("--mqtt-port", type=int, default=int(os.environ.get("MQTT_PORT", "1883")))
    p.add_argument("--ditto-url", default=os.environ.get("DITTO_URL", "http://localhost:8080"))
    p.add_argument("--ditto-user", default=os.environ.get("DITTO_USER", "ditto"))
    p.add_argument("--ditto-password", default=os.environ.get("DITTO_PASSWORD", ""))
    p.add_argument("--interval", type=float, default=float(os.environ.get("SIM_INTERVAL", "2")),
                   help="real seconds between publishes, and between Ditto control-feature polls -- "
                        "always the same timer, see publisher_process (default 2)")
    p.add_argument("--speedup", type=float, default=float(os.environ.get("SIM_SPEEDUP", c.DEFAULT_SIM_SPEEDUP)),
                   help="simulated seconds per real second (default 10)")
    p.add_argument("--seed", type=int, default=int(os.environ.get("SIM_SEED", "42")))
    p.add_argument("--dry-run", action="store_true", help="print messages instead of publishing, skip Ditto polling")
    p.add_argument("--no-poll", action="store_true", help="publish-only, skip Ditto polling (control features stay fixed)")
    p.add_argument("--steps", type=int, default=0, help="stop after N publishes (0 = run forever)")
    args = p.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    section = Section(args.seed)
    env = simpy.rt.RealtimeEnvironment(factor=1.0 / args.speedup, strict=False)
    for exc in section.excavators.values():
        exc.resource = simpy.Resource(env, capacity=1)

    client = None
    if not args.dry_run:
        client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f"openegiz-team-mine-sim-{os.getpid()}")
        for attempt in range(30):
            try:
                client.connect(args.mqtt_host, args.mqtt_port, keepalive=30)
                break
            except OSError as exc:
                log.warning("MQTT %s:%s not reachable (%s), retrying", args.mqtt_host, args.mqtt_port, exc)
                time.sleep(2)
        else:
            log.error("giving up on MQTT %s:%s", args.mqtt_host, args.mqtt_port)
            return 1
        client.loop_start()
        log.info("publishing to mqtt://%s:%s every %.1fs at %.0fx speed",
                 args.mqtt_host, args.mqtt_port, args.interval, args.speedup)

    for eid, exc in section.excavators.items():
        env.process(reliability_process(env, section, exc, c.EXCAVATOR_MTBF_H, c.EXCAVATOR_MTTR_H, "idle"))
    env.process(reliability_process(env, section, section.crusher, c.CRUSHER_MTBF_H, c.CRUSHER_MTTR_H, "idle"))
    env.process(face_grade_process(env, section))
    env.process(shift_process(env, section))
    env.process(stockpile_reclaim_process(env, section))
    env.process(crusher_drain_process(env, section))
    for truck_id in section.trucks:
        env.process(truck_process(env, section, truck_id))

    poller = None
    if not args.dry_run and not args.no_poll:
        if not args.ditto_password:
            log.error("--ditto-password (or DITTO_PASSWORD) is required unless --dry-run or --no-poll")
            return 1
        poller = DittoPoller(args.ditto_url, args.ditto_user, args.ditto_password)

    env.process(publisher_process(env, section, client, poller, args.interval * args.speedup, args))

    stop = False

    def on_signal(*_):
        nonlocal stop
        stop = True

    signal.signal(signal.SIGINT, on_signal)
    signal.signal(signal.SIGTERM, on_signal)

    try:
        while not stop:
            env.step()
    except StopSimulation:
        pass
    except simpy.core.EmptySchedule:
        pass

    if client:
        client.loop_stop()
        client.disconnect()
    return 0


if __name__ == "__main__":
    sys.exit(main())
