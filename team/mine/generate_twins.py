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
            "tonnes_actual": {"value": 0, "unit": "t"},
            "grade_actual": {"value": 0, "unit": "% Cu"},
            "time_remaining_min": {"value": c.SHIFT_HOURS * 60, "unit": "min"},
            "plan_completion_pct": {"value": 0, "unit": "%"},
            "shift_number": {"value": 1},
        },
    )

    face_grades = {
        "face-ore-01": ("sulfide", c.FACE_ORE_01_GRADE_PCT),
        "face-ore-02": ("sulfide", c.FACE_ORE_02_GRADE_PCT),
    }
    for face_id, (ore_type, grade) in face_grades.items():
        twins[face_id] = thing(
            "face", face_id.replace("-", " ").title(), parent="section-01",
            attributes={"ore_type": ore_type, "target_grade_pct": grade},
            features={"state": {"value": "active"}, "grade": {"value": grade, "unit": "% Cu"}},
        )
    twins["face-waste-01"] = thing(
        "face", "Вскрышной уступ", parent="section-01",
        attributes={"ore_type": "waste"},
        features={"state": {"value": "active"}},
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

    road_edges = {
        "road-face1": ("face-ore-01", "junction-01", "primary"),
        "road-face2": ("face-ore-02", "junction-01", "primary"),
        "road-main-a": ("junction-01", "crusher-01", "primary"),
        "road-main-b": ("junction-01", "crusher-01", "backup"),
        "road-waste": ("face-waste-01", "dump-01", "primary"),
    }
    for road_id, (frm, to, priority) in road_edges.items():
        twins[road_id] = thing(
            "road", road_id.replace("-", " ").title(), parent="section-01",
            attributes={
                "from": frm, "to": to, "priority": priority,
                "length_km": c.ROAD_LENGTHS_KM[road_id],
                "max_grade_pct": c.ROAD_MAX_GRADE_PCT, "width_m": c.ROAD_WIDTH_M,
                # Operator command. The `state` feature below is the
                # simulator's own read-only mirror of it.
                "closed": False,
            },
            features={"state": {"value": "open"}, "trucks_on_road": {"value": 0, "unit": "trucks"}},
        )

    twins["junction-01"] = thing(
        "junction", "Развязка Р-1", parent="section-01",
        features={"trucks_at_junction": {"value": 0, "unit": "trucks"}},
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
        features={
            "state": {"value": "stopped"},
            "throughput_tph": {"value": 0, "unit": "t/h"},
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
