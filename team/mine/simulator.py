#!/usr/bin/env python3
"""Discrete-event simulator for the team's open-pit section (SimPy).

Haul cycle per truck: queue at its assigned excavator -> load (bucket
passes) -> haul to crusher (ore) or dump (waste) via the road graph ->
dump -> refuel if low -> haul back empty -> repeat. Ore trucks route
face -> junction -> crusher, picking whichever main road segment
(road-main-a primary, road-main-b backup) is open; closing both blocks
that flow, closing one just lengthens the cycle (see
../docs/design-twins.md section 5).

Control loop: this process is the only writer of each twin's descriptive
`state` (and similar telemetry); an operator never writes `state` on an
excavator/truck/crusher directly -- they write the dedicated `forced_down`
boolean instead (polled from Ditto's REST API every tick, immediately
before that same tick's publish -- not a separate timer, see
publisher_process for why -- and read fresh at each truck's safe decision
points). Roads have no competing writer, so their `state` (open/closed) is
polled and read directly. This is deliberately a poll loop, not a live
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
import urllib.request
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
    resource: object = None

    def features(self, trucks_assigned):
        return {
            "state": {"value": self.state},
            "tonnes_loaded_shift": {"value": round(self.tonnes_loaded_shift, 1), "unit": "t"},
            "passes_total": {"value": self.passes_total, "unit": "passes"},
            "trucks_assigned": {"value": trucks_assigned, "unit": "trucks"},
            "forced_down": {"value": self.forced_down},
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
            "assigned_excavator": {"value": self.assigned_excavator},
            "trips_total": {"value": self.trips_total, "unit": "trips"},
            # Echo back, never a fixed default: a `modify` replaces every
            # feature at once (see OPENEGIZ.md), so publishing anything else
            # here would stomp the operator's own forced_down command on its
            # next poll-publish round trip.
            "forced_down": {"value": self.forced_down},
        }


@dataclass
class Road:
    id: str
    length_km: float
    max_grade_pct: float
    state: str = "open"

    def features(self, trucks_on_road):
        return {"state": {"value": self.state}, "trucks_on_road": {"value": trucks_on_road, "unit": "trucks"}}


@dataclass
class Crusher:
    state: str = "idle"
    forced_down: bool = False
    tonnes_shift: float = 0.0
    repair_eta: float = -1.0
    window_log: list = field(default_factory=list)  # (sim_time, tonnes, grade), last CRUSHER_WINDOW_S
    hopper_t: float = 0.0     # tipped but not yet "processed" -- smooths bursts, caps throughput_tph
    hopper_grade: float = 0.0

    def hopper_add(self, tonnes, grade):
        """Trucks (direct dump) and stockpile reclaim both land here, not in
        `add()` directly -- draining this at CRUSHER_TARGET_TPH (see
        crusher_drain_process) is what stops reported throughput_tph from
        exceeding the crusher's own sourced rated capacity."""
        new_total = self.hopper_t + tonnes
        if new_total > 0:
            self.hopper_grade = (self.hopper_grade * self.hopper_t + grade * tonnes) / new_total
        self.hopper_t = new_total

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
            "forced_down": {"value": self.forced_down},
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
            rid: Road(rid, c.ROAD_LENGTHS_KM[rid], c.ROAD_MAX_GRADE_PCT) for rid in c.ROAD_LENGTHS_KM
        }
        ore_assign = c.initial_truck_assignment()
        self.trucks = {
            f"truck-{i:02d}": Truck(f"truck-{i:02d}", ore_assign[i - 1]) for i in range(1, c.FLEET_SIZE + 1)
        }
        self.crusher = Crusher()
        self.stockpile = Stockpile()
        self.dump_tonnes_current = 0.0
        self.dump_tonnes_shift = 0.0
        self.shift_tonnes_grade_sum = 0.0  # cumulative, whole shift (unlike crusher.window_log)

    # -- shared helpers used by truck processes ------------------------------
    def choose_open_road(self, candidates):
        for rid in candidates:
            if self.roads[rid].state != "closed":
                return rid
        return None

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
    grade_factor = max(0.6, 1.0 - (road.max_grade_pct / 100.0) * 1.5)  # ASSUMPTION: linear grade penalty
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

        with exc.resource.request() as req:
            truck.state = "queued_at_excavator"
            yield req
            truck.state = "loading"
            exc.state = "loading"
            load_s = c.EXCAVATOR_PASSES_TO_FILL * c.EXCAVATOR_CYCLE_S * section.rng.uniform(0.9, 1.1)
            yield env.timeout(load_s)
            truck.payload_t = c.TRUCK_CAPACITY_T
            truck.grade = section.face_grade.get(info["face"], 0.0)
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
            yield from haul_leg(env, section, truck, main_id, loaded=True)
            truck.state = "queued_at_crusher"
            yield env.timeout(c.SPOT_SECONDS)
            if section.crusher.state == "down":
                while section.stockpile.tonnes_current >= c.STOCKPILE_CAPACITY_T:
                    truck.state = "queued_stockpile_full"
                    yield env.timeout(POLL_WAIT_S)
                truck.state = "dumping"
                yield env.timeout(c.DUMP_SECONDS)
                section.stockpile.add(truck.payload_t, truck.grade)
            else:
                truck.state = "dumping"
                yield env.timeout(c.DUMP_SECONDS)
                section.crusher.hopper_add(truck.payload_t, truck.grade)

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
    """
    while True:
        yield env.timeout(POLL_WAIT_S)
        if unit.state == "down":
            if env.now >= unit.repair_eta:
                unit.state = idle_state
            continue
        random_trigger = section.rng.random() < (POLL_WAIT_S / (mtbf_h * 3600.0))
        if unit.forced_down or random_trigger:
            unit.state = "down"
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


def stockpile_reclaim_process(env, section):
    tick_s = 120.0
    while True:
        yield env.timeout(tick_s)
        if section.crusher.state != "down" and section.stockpile.tonnes_current > 0:
            amount = min(section.stockpile.tonnes_current, c.STOCKPILE_RECLAIM_TPH * (tick_s / 3600.0))
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
    def __init__(self, base_url, user, password, timeout_s=3.0):
        self.base_url = base_url.rstrip("/")
        self.auth = "Basic " + base64.b64encode(f"{user}:{password}".encode()).decode()
        self.timeout_s = timeout_s

    def get_features(self, thing_id):
        req = urllib.request.Request(
            f"{self.base_url}/api/2/things/{c.NAMESPACE}:{thing_id}?fields=features",
            headers={"Authorization": self.auth},
        )
        with urllib.request.urlopen(req, timeout=self.timeout_s) as resp:
            return json.loads(resp.read()).get("features", {})

    def poll_into(self, section):
        for road_id, road in section.roads.items():
            try:
                feats = self.get_features(road_id)
                state = feats.get("state", {}).get("properties", {}).get("value")
                if state in ("open", "closed"):
                    road.state = state
            except (urllib.error.URLError, TimeoutError, ValueError, OSError) as exc:
                log.debug("poll %s failed: %s", road_id, exc)

        for exc_id, exc in section.excavators.items():
            try:
                feats = self.get_features(exc_id)
                exc.forced_down = bool(feats.get("forced_down", {}).get("properties", {}).get("value", False))
            except (urllib.error.URLError, TimeoutError, ValueError, OSError) as exc_err:
                log.debug("poll %s failed: %s", exc_id, exc_err)

        try:
            feats = self.get_features("crusher-01")
            section.crusher.forced_down = bool(feats.get("forced_down", {}).get("properties", {}).get("value", False))
        except (urllib.error.URLError, TimeoutError, ValueError, OSError) as exc_err:
            log.debug("poll crusher-01 failed: %s", exc_err)

        for truck_id, truck in section.trucks.items():
            try:
                feats = self.get_features(truck_id)
                truck.forced_down = bool(feats.get("forced_down", {}).get("properties", {}).get("value", False))
                assigned = feats.get("assigned_excavator", {}).get("properties", {}).get("value")
                if assigned in EXCAVATOR_INFO:
                    truck.assigned_excavator = assigned
            except (urllib.error.URLError, TimeoutError, ValueError, OSError) as exc_err:
                log.debug("poll %s failed: %s", truck_id, exc_err)


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
        state = "blocked" if section.roads[road_id].state == "closed" else "active"
        feats = {"state": {"value": state}}
        if face_id in section.face_grade:
            feats["grade"] = {"value": round(section.face_grade[face_id], 3), "unit": "% Cu"}
        things[face_id] = feats

    things["junction-01"] = {"trucks_at_junction": {"value": trucks_at_junction, "unit": "trucks"}}

    crusher_feats, crusher_state = section.crusher.features(now)
    things["crusher-01"] = crusher_feats
    things["conveyor-01"] = {
        "state": {"value": "running" if crusher_state == "crushing" else "stopped"},
        "throughput_tph": crusher_feats["throughput_tph"],
        "tonnes_shift": crusher_feats["tonnes_shift"],
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
    things["shift-01"] = {
        "plan_tonnes": {"value": round(c.PLAN_TONNES_SHIFT, 1), "unit": "t"},
        "plan_grade_min": {"value": c.PLAN_GRADE_MIN_PCT, "unit": "% Cu"},
        "tonnes_actual": {"value": round(tonnes_actual, 1), "unit": "t"},
        "grade_actual": {"value": round(section.shift_grade_actual(), 3), "unit": "% Cu"},
        "time_remaining_min": {"value": round(max(0.0, c.SHIFT_HOURS * 60 - now / 60.0), 1), "unit": "min"},
        "plan_completion_pct": {"value": round(100.0 * tonnes_actual / c.PLAN_TONNES_SHIFT, 1), "unit": "%"},
    }
    return things


def publisher_process(env, section, client, poller, interval_sim_s, args):
    """Poll-then-publish, both in the same tick of the same process.

    They used to be two independent periodic processes. Confirmed live
    against Ditto that this races: if an unrelated publish fires in the
    narrow window between an operator's write and the next poll, it
    overwrites that write with the stale in-memory value, and the next
    poll then reads back its own stale echo -- the operator's command is
    silently lost with no error anywhere. Driving both from one timer
    makes that window impossible (see team/docs/design-twins.md section 7)."""
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
