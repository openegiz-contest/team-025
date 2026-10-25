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

# Fuel burn: Komatsu does not publish a spec-sheet rate for the 930E-5SE
# (design-twins.md 3.3), so these are the team's assumption -- but they are
# back-calculated from the one figure that is not in doubt, the hourly burn of
# a 2700 hp ultra-class truck, which the literature puts at roughly 250 l/h
# averaged over a duty cycle.
#
# Per-km rather than per-hour because the model only burns fuel while a truck
# is travelling: an idling truck at a queue burns nothing here. So the per-km
# figures carry the idle burn too, chosen so a whole Face-1 cycle (4.8 km in
# 17.0 min) comes to ~71 l, i.e. ~250 l/h over the cycle.
#
# The earlier values (4.4 / 2.6) gave 59 l/h -- four times low. Nothing in the
# model broke, which is exactly why it survived: fuel_pct just crept down so
# slowly that refuelling needed 61 simulated hours, so `refueling` and the
# fuel-station twin were unreachable in any session anyone would sit through.
# At 250 l/h a truck burns about two thirds of its tank in a 12-hour shift.
FUEL_LPKM_LOADED = 19.5              # ASSUMPTION, see above
FUEL_LPKM_EMPTY = 10.0               # ASSUMPTION, see above
REFUEL_BELOW_PCT = 20.0
REFUEL_SECONDS = 600.0               # ASSUMPTION

# -- Benches and elevations -------------------------------------------------
# ASSUMPTION: the section's vertical layout. Aktogay's real bench elevations
# are not public (the Concept says so), so these are our own, chosen to be
# internally consistent: the crusher sits on the pad at the reference level,
# the ore benches are cut below it, and stripping works a bench above the rim.
# The deeper ore bench is the leaner one, which is why FACE_ORE_02_GRADE_PCT
# is the lower of the two.
#
# These are what make the haul roads geometrically different from each other
# instead of five copies of one number -- see road_avg_grade_pct() below.
BENCH_HEIGHT_M = 15.0  # ASSUMPTION: typical 15 m benches for this scale
NODE_ELEVATION_M = {
    "crusher-01": 0.0,       # reference level: the plant pad
    "junction-01": -15.0,
    "face-ore-01": -45.0,    # bench -45
    "face-ore-02": -60.0,    # bench -60, deeper and leaner
    "face-waste-01": 10.0,   # stripping a bench above the rim
    "dump-01": 20.0,         # crest of the waste dump, a growing landform
}

BENCHES = {
    # bench id: (elevation, which face works it, ore or waste)
    "bench-n45": (-45.0, "face-ore-01", "sulfide"),
    "bench-n60": (-60.0, "face-ore-02", "sulfide"),
    "bench-p10": (10.0, "face-waste-01", "waste"),
}

# -- Roads ------------------------------------------------------------------
# SOURCED: US Bureau of Mines IC 8758 -- sustained optimum grade. This is the
# ceiling a haul road is designed to, not the grade every road actually has.
# ASSUMPTION: fractional loss of haul speed per 1% of climbing grade. 0.08
# puts a loaded truck on the 3.5% ramp out of bench -60 at ~72% of its flat
# speed, which is the right order for a 220 t class truck on a rimpull curve.
GRADE_SPEED_PENALTY = 0.08

ROAD_RULING_GRADE_CAP_PCT = 9.0

# ASSUMPTION: a haul road is part ramp and part near-level bench road, so its
# ruling grade -- the one that sizes haulage -- is steeper than its average
# rise over run. Factor 2.5 is our own, and the result is capped at the
# sourced ceiling above.
RULING_GRADE_FACTOR = 2.5
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

# Which nodes each road joins. The single source of truth for the road graph:
# generate_twins.py publishes it as attributes.from/to, and the ruling grade
# below is derived from the elevation difference across it.
ROAD_EDGES = {
    "road-face1": ("face-ore-01", "junction-01", "primary"),
    "road-face2": ("face-ore-02", "junction-01", "primary"),
    "road-main-a": ("junction-01", "crusher-01", "primary"),
    "road-main-b": ("junction-01", "crusher-01", "backup"),
    "road-waste": ("face-waste-01", "dump-01", "primary"),
}


def road_avg_grade_pct(road_id):
    """Rise over run, in percent, from the two ends' elevations."""
    frm, to, _ = ROAD_EDGES[road_id]
    rise = abs(NODE_ELEVATION_M[to] - NODE_ELEVATION_M[frm])
    return rise / (ROAD_LENGTHS_KM[road_id] * 1000.0) * 100.0


def road_ruling_grade_pct(road_id):
    """The grade haulage is sized on. Derived, not assumed per road: a road
    that drops further over its length rules steeper. Capped at the sourced
    ceiling."""
    return round(min(ROAD_RULING_GRADE_CAP_PCT,
                     road_avg_grade_pct(road_id) * RULING_GRADE_FACTOR), 1)

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
# ASSUMPTION: the crusher's dump pocket holds about three truck loads -- the
# order of magnitude of a primary gyratory's surge pocket, not a Sandvik
# figure. It exists to smooth the gap between a truck arriving all at once
# and the crusher drawing down steadily.
#
# It is load-bearing, not decoration. Without a ceiling the pocket silently
# absorbed every tonne the fleet over-delivered: measured on the live stand,
# 37% of everything mined vanished into it, the stockpile never filled, and
# reported throughput sat on CRUSHER_TARGET_TPH no matter what the dispatcher
# did -- so losing a shovel moved no KPI at all. A truck that finds the
# pocket full now tips to the stockpile instead (see truck_process).
CRUSHER_HOPPER_CAPACITY_T = 3 * TRUCK_CAPACITY_T

# -- Conveyor to the concentrator -------------------------------------------
# ASSUMPTION: the belt is sized above the crusher's operating setpoint but
# below its rated maximum, so a crusher running flat out can briefly outrun
# the belt. That makes the conveyor its own constraint rather than a mirror
# of the crusher.
CONVEYOR_RATED_TPH = 3000.0
CONVEYOR_BELT_SPEED_MPS = 4.5   # ASSUMPTION: ordinary overland belt speed
CONVEYOR_LENGTH_M = 1200.0      # ASSUMPTION: crusher pad to the plant
# What the belt carries is not what the crusher is making right now: it is
# what the crusher was making CONVEYOR_TRANSIT_S ago. That delay is why the
# belt keeps running after the crusher stops -- it still has to clear itself.
CONVEYOR_TRANSIT_S = CONVEYOR_LENGTH_M / CONVEYOR_BELT_SPEED_MPS

# -- Face reserves ----------------------------------------------------------
# ASSUMPTION: broken-and-ready tonnage standing in front of each shovel. Sized
# at a few shifts' worth so a bench is not emptied inside one shift, but a
# dispatcher who parks the whole fleet on one face can visibly deplete it --
# which is what makes "do not burn the rich face first" a real constraint and
# not just a sentence in a module's description.
FACE_RESERVES_T = {
    "face-ore-01": 120_000.0,
    "face-ore-02": 160_000.0,   # the deeper, leaner bench is the larger block
    "face-waste-01": 400_000.0,
}

# -- Stripping ratio: two different numbers, deliberately both published ----
# SOURCED (secondary, miningdataonline on KAZ Minerals ESG reporting): Aktogay
# plans a life-of-mine stripping ratio of about 0.2 t waste per t of ore.
# That is a whole-mine average over decades -- it is the number the deposit
# has, not the number any one shift runs.
LOM_STRIPPING_RATIO = 0.2
# ASSUMPTION: this section is stripping ahead of its ore benches (face-waste-01
# sits on bench +10, above the two ore benches it has to uncover), so its own
# shift plan is well above the life-of-mine average.
#
# The figure is DERIVED from the designed fleet split rather than declared, for
# the same reason road grades are: a declared one drifts. It was declared 0.65
# and described as "what the split delivers"; the split actually delivers 0.52,
# and nothing caught the gap because nothing recomputed it.
#
# Both numbers reach the Stand on shift-01 so the difference is stated, not
# hidden: a dispatcher reading only the life-of-mine figure would think the
# section were over-stripping by 2.5x, when it is doing what it was sent to do.
def _design_stripping_ratio():
    """Waste t/h over ore t/h that ORE_TRUCK_COUNT / WASTE_TRUCK_COUNT deliver."""
    load_s = EXCAVATOR_PASSES_TO_FILL * EXCAVATOR_CYCLE_S

    def cycle_s(roads):
        travel = 0.0
        for road in roads:
            grade = road_avg_grade_pct(road)
            km = ROAD_LENGTHS_KM[road]
            up = min(TRUCK_MAX_SPEED_KMH,
                     SPEED_LOADED_KMH_BASE * max(0.5, 1.0 - grade * GRADE_SPEED_PENALTY))
            travel += (km / up + km / SPEED_EMPTY_KMH_BASE) * 3600.0 / JOB_EFFICIENCY
        return load_s + SPOT_SECONDS + travel + DUMP_SECONDS

    half = ORE_TRUCK_COUNT // 2
    tph = lambda n, roads: n * TRUCK_CAPACITY_T * 3600.0 / cycle_s(roads)
    ore = tph(half, ["road-face1", "road-main-a"]) + tph(ORE_TRUCK_COUNT - half, ["road-face2", "road-main-a"])
    waste = tph(WASTE_TRUCK_COUNT, ["road-waste"])
    return round(waste / ore, 2) if ore else 0.0

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


# Evaluated at the end of the module: _design_stripping_ratio() reads the fleet
# split and the road graph, both declared above.
PLAN_STRIPPING_RATIO = _design_stripping_ratio()
