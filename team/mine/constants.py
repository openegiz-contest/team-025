"""Shared constants for the team's open-pit section twin.

Every value is tagged SOURCED or ASSUMPTION. SOURCED values and their exact
citations are in ../docs/design-twins.md (sections 3 and 5); do not change a
SOURCED number without updating that file too. ASSUMPTION values are the
team's own engineering judgment where no public source exists -- expected
and allowed (see SUBMISSION.md -> Data and Assumptions), just never to be
presented as sourced.

Fictional section calibrated to the Aktogay copper mine (KAZ Minerals,
Kazakhstan); see SUBMISSION.md -> Concept for why.
"""

NAMESPACE = "org.openegiz.pit"

# Default simulated-seconds-per-real-second (matches simulator.py's --speedup
# default). Also seeded onto section-01's initial sim_speedup feature so the
# viewer has a sane value to extrapolate truck motion with even before the
# simulator's first publish.
DEFAULT_SIM_SPEEDUP = 10.0

# -- Shift plan ---------------------------------------------------------
# SOURCED: 2850 t/h is the team's own calc from Aktogay's 25 Mt/yr per
# sulfide line (design-twins.md 3.1) / 8760 h.
PLAN_TPH = 2850.0
SHIFT_HOURS = 12.0  # ASSUMPTION: common two-12h-shift pattern, not Aktogay-specific
PLAN_TONNES_SHIFT = PLAN_TPH * SHIFT_HOURS
# ASSUMPTION: between the reserve-grade baseline (0.33%) and the achieved
# plant-feed blend (0.41-0.43%, design-twins.md 3.1) -- a defensible target,
# not itself a cited figure.
PLAN_GRADE_MIN_PCT = 0.38

# -- Ore faces ------------------------------------------------------------
# ASSUMPTION: calibrated so an even truck split across the two faces blends
# to ~0.41% Cu, matching Aktogay's actual 2024-2025 plant feed (design-twins.md 3.2).
FACE_ORE_01_GRADE_PCT = 0.50
FACE_ORE_02_GRADE_PCT = 0.33

# -- Excavator: Komatsu PC8000, paired with the 930E in Komatsu's own
# "Loading Tool Selection Guide" (SOURCED, design-twins.md 3.3).
EXCAVATOR_MODEL = "Komatsu PC8000"
EXCAVATOR_BUCKET_M3 = 42.0           # SOURCED
EXCAVATOR_PASSES_TO_FILL = 4         # SOURCED (matching chart, 930E)
EXCAVATOR_CYCLE_S = 29.0             # SOURCED (midpoint of 25-33s @ 70 deg swing)
EXCAVATOR_AVAILABILITY = 0.90        # SOURCED floor ("90%+", Komatsu manufacturer claim)
EXCAVATOR_MTBF_H = 500.0             # ASSUMPTION (non-peer-reviewed industry blog range 400-600h)
EXCAVATOR_MTTR_H = 4.0               # ASSUMPTION (illustrative only, not a cited figure)

# Bulk density implied by Komatsu's own passes-to-fill: 290 t / 4 passes /
# 42 m3 ~= 1.73 t/m3. Derived, not independently sourced (design-twins.md 3.5).
BULK_DENSITY_T_M3 = (290.0 / EXCAVATOR_PASSES_TO_FILL) / EXCAVATOR_BUCKET_M3

# -- Haul truck: Komatsu 930E-5SE (SOURCED, design-twins.md 3.3, brochure PDF).
TRUCK_MODEL = "Komatsu 930E-5SE"
TRUCK_CAPACITY_T = 290.0             # SOURCED
TRUCK_MAX_SPEED_KMH = 64.5           # SOURCED
TRUCK_WIDTH_M = 9.15                 # SOURCED (brochure dimensions page)
TRUCK_TANK_L = 4542.0                # SOURCED (Tier 4 tank)
TRUCK_AVAILABILITY = 0.85            # ASSUMPTION (no solid source, see design-twins.md 3.5)
TRUCK_MTBF_H = 300.0                 # ASSUMPTION
TRUCK_MTTR_H = 2.0                   # ASSUMPTION

# Fuel burn: Komatsu does not publish a spec-sheet rate (design-twins.md
# 3.3). These per-km rates are the team's assumption, loosely informed by
# the (non-comparable, normalized) Mogalakwena case-study figures.
FUEL_LPKM_LOADED = 4.4               # ASSUMPTION
FUEL_LPKM_EMPTY = 2.6                # ASSUMPTION
REFUEL_BELOW_PCT = 20.0
REFUEL_SECONDS = 600.0               # ASSUMPTION

# -- Roads ------------------------------------------------------------------
# SOURCED: US Bureau of Mines IC 8758 -- sustained optimum grade.
ROAD_MAX_GRADE_PCT = 9.0
# SOURCED (secondary citation only, original not accessed): ~3.5x the
# widest truck.
ROAD_WIDTH_M = round(3.5 * TRUCK_WIDTH_M, 1)
# ASSUMPTION: section geometry is not public (the Concept says so explicitly);
# lengths are one-way, km. main-b is the longer detour around main-a.
ROAD_LENGTHS_KM = {
    "road-face1": 1.2,
    "road-face2": 1.3,
    "road-main-a": 1.2,
    "road-main-b": 2.0,
    "road-waste": 2.6,
}

# ASSUMPTION: below the truck's rated max (64.5 km/h) for grade, curves and
# safety margin -- same spirit as the Example Mine's constants.
SPEED_LOADED_KMH_BASE = 25.0
SPEED_EMPTY_KMH_BASE = 35.0

# -- Job efficiency (SOURCED: Caterpillar Performance Handbook Ed.50, "50 min/h").
JOB_EFFICIENCY = 50.0 / 60.0

# -- Crusher: Sandvik CG820i (SOURCED range, design-twins.md 3.3); the
# setting is tuned toward the top of the range to hit the ~2850 t/h target.
CRUSHER_MODEL = "Sandvik CG820i"
CRUSHER_RATED_TPH_MIN = 2000.0       # SOURCED
CRUSHER_RATED_TPH_MAX = 3100.0       # SOURCED
CRUSHER_AVAILABILITY = 0.90          # ASSUMPTION
CRUSHER_MTBF_H = 400.0               # ASSUMPTION (illustrative, see design-twins.md 3.5)
CRUSHER_MTTR_H = 4.0                 # ASSUMPTION
# ASSUMPTION: operating setpoint inside the sourced CG820i range (above),
# chosen to match the team's own ~2850 t/h plan rate. Caps how fast the
# crusher's hopper can drain -- without this, simulated throughput could
# exceed the crusher's own spec sheet, which would look wrong on the Stand.
CRUSHER_TARGET_TPH = 2850.0

# -- Stockpile / dump (ASSUMPTION: no source for section-specific sizing).
STOCKPILE_CAPACITY_T = 5000.0
STOCKPILE_RECLAIM_TPH = 1200.0  # ASSUMPTION: reclaim feeder is slower than direct tipping
DUMP_CAPACITY_T = 2_000_000.0  # effectively unbounded within a shift

# -- Misc cycle timings (ASSUMPTION, same spirit as Example Mine).
DUMP_SECONDS = 90.0
SPOT_SECONDS = 30.0  # queueing/maneuvering overhead at excavator or crusher

FLEET_SIZE = 6          # see design-twins.md 4: ~4 continuously on ore + 2 on waste
ORE_TRUCK_COUNT = 4
WASTE_TRUCK_COUNT = FLEET_SIZE - ORE_TRUCK_COUNT


def initial_truck_assignment():
    """truck-01.. -> excavator id, length FLEET_SIZE. Single source of truth
    so generate_twins.py (starting features) and simulator.py (in-memory
    default) can never drift apart."""
    half = ORE_TRUCK_COUNT // 2
    return (
        ["excavator-01"] * half
        + ["excavator-02"] * (ORE_TRUCK_COUNT - half)
        + ["excavator-03"] * WASTE_TRUCK_COUNT
    )
