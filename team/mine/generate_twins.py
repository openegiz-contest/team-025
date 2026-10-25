#!/usr/bin/env python3
r"""Generate twins.json for the team's open-pit section from constants.py.

Run after changing constants.py, then commit the resulting twins.json (same
pattern as examples/mine: a static file consumed by setup_twins.py, so
nothing needs to run at container build/start time just to create twins).

    python generate_twins.py

Topology (see ../docs/design-twins.md section 1 and 5):

    face-ore-01 --road-face1--\
                                junction-01 --road-main-a (primary)--\
    face-ore-02 --road-face2--/            \--road-main-b (backup)--/--> crusher-01 -> stockpile-01
                                                                          |
                                                                     conveyor-01 -> (plant, outside the model)

    face-waste-01 --road-waste--> dump-01
"""

import json
import os

import constants as c

POLICY = "default:basic_policy"


def thing(kind, name, parent=None, attributes=None, features=None):
    attrs = {"name": name, "_isType": False, "kind": kind}
    if parent:
        attrs["_parents"] = f"{c.NAMESPACE}:{parent}"
    attrs.update(attributes or {})
    feats = {k: {"properties": v} for k, v in (features or {}).items()}
    return {"policyId": POLICY, "attributes": attrs, "features": feats}


def main():
    twins = {}

    twins["section-01"] = thing(
        "mine-section", "Участок медного карьера (вымышленный, по Актогай)",
        # Planning parameters live on the twin so that anything reasoning about
        # the section -- the dispatch optimiser in the viewer, in particular --
        # reads them from Ditto instead of hardcoding its own copy of the
        # physics. constants.py stays the single source of truth.
        attributes={
            "speed_loaded_kmh": c.SPEED_LOADED_KMH_BASE,
            "speed_empty_kmh": c.SPEED_EMPTY_KMH_BASE,
            "job_efficiency": round(c.JOB_EFFICIENCY, 4),
            "dump_s": c.DUMP_SECONDS,
            "spot_s": c.SPOT_SECONDS,
            "grade_speed_penalty": c.GRADE_SPEED_PENALTY,
        },
        features={
            "tonnes_to_crusher_shift": {"value": 0, "unit": "t"},
            "feed_grade": {"value": 0, "unit": "% Cu"},
            "trucks_active": {"value": 0, "unit": "trucks"},
            "sim_speedup": {"value": c.DEFAULT_SIM_SPEEDUP, "unit": "simulated s / real s"},
        },
    )

    twins["shift-01"] = thing(
        "shift", "План смены", parent="section-01",
        attributes={"shift_hours": c.SHIFT_HOURS},
        features={
            "plan_tonnes": {"value": round(c.PLAN_TONNES_SHIFT, 1), "unit": "t"},
            "plan_grade_min": {"value": c.PLAN_GRADE_MIN_PCT, "unit": "% Cu"},
            "plan_stripping_ratio": {"value": c.PLAN_STRIPPING_RATIO, "unit": "t/t"},
            "lom_stripping_ratio": {"value": c.LOM_STRIPPING_RATIO, "unit": "t/t"},
            "stripping_ratio_actual": {"value": 0, "unit": "t/t"},
            "waste_tonnes_actual": {"value": 0, "unit": "t"},
            "tonnes_actual": {"value": 0, "unit": "t"},
            "grade_actual": {"value": 0, "unit": "% Cu"},
            "time_remaining_min": {"value": c.SHIFT_HOURS * 60, "unit": "min"},
            "plan_completion_pct": {"value": 0, "unit": "%"},
            "shift_number": {"value": 1},
        },
    )

    # A bench is the horizontal slice the pit is mined in. It is what gives the
    # section its vertical extent: every face sits on one, and a face's working
    # elevation is its bench's. Benches are separate twins rather than an
    # attribute of the face because one bench can carry several faces as the
    # cut advances along it.
    bench_names = {"bench-n45": "Уступ −45", "bench-n60": "Уступ −60", "bench-p10": "Уступ +10"}
    for bench_id, (elev, face_id, material) in c.BENCHES.items():
        twins[bench_id] = thing(
            "bench", bench_names[bench_id], parent="section-01",
            attributes={
                "elevation_m": elev,
                "height_m": c.BENCH_HEIGHT_M,
                "material": material,
                "face": face_id,
            },
            features={
                "state": {"value": "active"},
                "tonnes_mined_shift": {"value": 0, "unit": "t"},
            },
        )

    face_bench = {face_id: bench_id for bench_id, (_, face_id, _) in c.BENCHES.items()}
    face_grades = {
        "face-ore-01": ("sulfide", c.FACE_ORE_01_GRADE_PCT),
        "face-ore-02": ("sulfide", c.FACE_ORE_02_GRADE_PCT),
    }
    for face_id, (ore_type, grade) in face_grades.items():
        twins[face_id] = thing(
            "face", face_id.replace("-", " ").title(), parent=face_bench[face_id],
            attributes={
                "ore_type": ore_type,
                "target_grade_pct": grade,
                "elevation_m": c.NODE_ELEVATION_M[face_id],
                "initial_reserves_t": c.FACE_RESERVES_T[face_id],
            },
            features={
                "state": {"value": "active"},
                "grade": {"value": grade, "unit": "% Cu"},
                # Broken tonnage still standing in front of the shovel. It only
                # falls, so parking the whole fleet on one face drains it.
                "reserves_t": {"value": c.FACE_RESERVES_T[face_id], "unit": "t"},
                "tonnes_mined_shift": {"value": 0, "unit": "t"},
            },
        )
    twins["face-waste-01"] = thing(
        "face", "Вскрышной забой", parent=face_bench["face-waste-01"],
        attributes={
            "ore_type": "waste",
            "elevation_m": c.NODE_ELEVATION_M["face-waste-01"],
            "initial_reserves_t": c.FACE_RESERVES_T["face-waste-01"],
        },
        features={
            "state": {"value": "active"},
            "reserves_t": {"value": c.FACE_RESERVES_T["face-waste-01"], "unit": "t"},
            "tonnes_mined_shift": {"value": 0, "unit": "t"},
        },
    )

    excavator_face = {"excavator-01": "face-ore-01", "excavator-02": "face-ore-02", "excavator-03": "face-waste-01"}
    for exc_id, face_id in excavator_face.items():
        twins[exc_id] = thing(
            "excavator", exc_id.replace("-", " ").title(), parent=face_id,
            attributes={
                "model": c.EXCAVATOR_MODEL, "bucket_m3": c.EXCAVATOR_BUCKET_M3,
                "cycle_time_s": c.EXCAVATOR_CYCLE_S,
                "passes_to_fill": c.EXCAVATOR_PASSES_TO_FILL,
                # Operator command, never written by the simulator -- see the
                # ownership split in simulator.py's module docstring.
                "forced_down": False,
            },
            features={
                "state": {"value": "idle"},
                "tonnes_loaded_shift": {"value": 0, "unit": "t"},
                "passes_total": {"value": 0, "unit": "passes"},
                "trucks_assigned": {"value": 0, "unit": "trucks"},
            },
        )

    # First ORE_TRUCK_COUNT trucks split across the two ore excavators, the
    # rest start on waste (design-twins.md section 4).
    excavators_cycle = c.initial_truck_assignment()
    for i in range(1, c.FLEET_SIZE + 1):
        truck_id = f"truck-{i:02d}"
        assigned = excavators_cycle[i - 1]
        twins[truck_id] = thing(
            "haul-truck", truck_id.replace("-", " ").title(), parent="section-01",
            attributes={
                "model": c.TRUCK_MODEL, "capacity_t": c.TRUCK_CAPACITY_T, "width_m": c.TRUCK_WIDTH_M,
                # Operator commands. `assigned_excavator` here is the
                # dispatcher's order; the feature of the same name below is
                # what the truck is actually working to, which lags the order
                # until the truck reaches its next safe decision point.
                "forced_down": False,
                "assigned_excavator": assigned,
            },
            features={
                "state": {"value": "queued_at_excavator"},
                "payload_t": {"value": 0, "unit": "t"},
                "speed_kmh": {"value": 0, "unit": "km/h"},
                "route_position_km": {"value": 0, "unit": "km"},
                "current_road": {"value": ""},
                "fuel_pct": {"value": 100, "unit": "%"},
                "assigned_excavator": {"value": assigned},
                "trips_total": {"value": 0, "unit": "trips"},
            },
        )

    for road_id, (frm, to, priority) in c.ROAD_EDGES.items():
        twins[road_id] = thing(
            "road", road_id.replace("-", " ").title(), parent="section-01",
            attributes={
                "from": frm, "to": to, "priority": priority,
                "length_km": c.ROAD_LENGTHS_KM[road_id],
                # The grade is derived from the two endpoints' elevations and
                # the road's length, not declared: a ramp out of a deep bench
                # is steep because it is deep, and the backup main is gentler
                # than the primary precisely because it is the longer way round.
                "elev_from_m": c.NODE_ELEVATION_M[frm],
                "elev_to_m": c.NODE_ELEVATION_M[to],
                "avg_grade_pct": round(c.road_avg_grade_pct(road_id), 2),
                "ruling_grade_pct": c.road_ruling_grade_pct(road_id),
                "width_m": c.ROAD_WIDTH_M,
                # Operator command. The `state` feature below is the
                # simulator's own read-only mirror of it.
                "closed": False,
            },
            features={"state": {"value": "open"}, "trucks_on_road": {"value": 0, "unit": "trucks"}},
        )

    twins["junction-01"] = thing(
        "junction", "Развязка Р-1", parent="section-01",
        attributes={
            "elevation_m": c.NODE_ELEVATION_M["junction-01"],
            "roads": [r for r, (f, t, _) in c.ROAD_EDGES.items()
                      if "junction-01" in (f, t)],
        },
        features={
            "state": {"value": "clear"},
            "trucks_at_junction": {"value": 0, "unit": "trucks"},
            "trucks_passed_shift": {"value": 0, "unit": "trucks"},
            "route_main": {"value": "road-main-a"},
        },
    )

    twins["stockpile-01"] = thing(
        "stockpile", "Рудный склад", parent="section-01",
        attributes={"capacity_t": c.STOCKPILE_CAPACITY_T},
        features={
            "tonnes_current": {"value": 0, "unit": "t"},
            "avg_grade": {"value": 0, "unit": "% Cu"},
            "reclaim_tph": {"value": 0, "unit": "t/h"},
        },
    )

    twins["crusher-01"] = thing(
        "crusher", "Первичная дробилка CR-01", parent="section-01",
        attributes={
            "model": c.CRUSHER_MODEL,
            "rated_tph_min": c.CRUSHER_RATED_TPH_MIN, "rated_tph_max": c.CRUSHER_RATED_TPH_MAX,
            "hopper_capacity_t": c.CRUSHER_HOPPER_CAPACITY_T,
            "forced_down": False,  # operator command
        },
        features={
            "state": {"value": "idle"},
            "throughput_tph": {"value": 0, "unit": "t/h"},
            "feed_grade": {"value": 0, "unit": "% Cu"},
            "tonnes_shift": {"value": 0, "unit": "t"},
            "hopper_t": {"value": 0, "unit": "t"},
        },
    )

    twins["conveyor-01"] = thing(
        "conveyor", "Конвейер на фабрику", parent="crusher-01",
        attributes={
            "rated_tph": c.CONVEYOR_RATED_TPH,
            "belt_speed_mps": c.CONVEYOR_BELT_SPEED_MPS,
            "length_m": c.CONVEYOR_LENGTH_M,
            "transit_s": round(c.CONVEYOR_TRANSIT_S),
        },
        features={
            "state": {"value": "stopped"},
            # Measured at the plant end, so it is what the crusher was making
            # one belt transit ago. The belt keeps running -- and the plant
            # keeps being fed -- for a full transit after the crusher stops.
            "throughput_tph": {"value": 0, "unit": "t/h"},
            "load_pct": {"value": 0, "unit": "%"},
            "on_belt_t": {"value": 0, "unit": "t"},
            "tonnes_shift": {"value": 0, "unit": "t"},
        },
    )

    twins["dump-01"] = thing(
        "waste-dump", "Отвал вскрыши", parent="section-01",
        attributes={"capacity_t": c.DUMP_CAPACITY_T},
        features={"tonnes_current": {"value": 0, "unit": "t"}, "tonnes_shift": {"value": 0, "unit": "t"}},
    )

    twins["fuel-01"] = thing(
        "fuel-station", "Заправка", parent="junction-01",
        features={"state": {"value": "idle"}, "trucks_queued": {"value": 0, "unit": "trucks"}},
    )

    twins["repair-01"] = thing(
        "repair-zone", "Ремзона", parent="section-01",
        features={"units_in_repair": {"value": 0, "unit": "units"}, "state": {"value": "idle"}},
    )

    out = {f"{c.NAMESPACE}:{name}": body for name, body in twins.items()}
    out_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "twins.json")
    with open(out_path, "w") as f:
        json.dump(out, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print(f"wrote {len(out)} twins to {out_path}")


if __name__ == "__main__":
    main()
