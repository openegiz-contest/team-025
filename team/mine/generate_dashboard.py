#!/usr/bin/env python3
"""Generate team/mine/dashboard.json -- a Grafana dashboard that supplements
the 3D scene (team/mine/viewer/) with historical trends and fleet/infra
status tables the scene doesn't show (it only shows the current instant).

Run after changing anything here, then commit the resulting dashboard.json
(same pattern as generate_twins.py -> twins.json: a static file, nothing
needs to run at container start just to produce it).

    python generate_dashboard.py

Query patterns (field naming, pivot/join idioms) are modeled directly on
examples/mine/dashboard.json -- see that file for the platform's own
reference. Datasource uid `opentwins-influxdb` and bucket `default` are
fixed by deploy/compose/grafana/provisioning/datasources/influxdb.yaml.
"""

import json
import os

NS = "org.openegiz.pit"
NS_RE = NS.replace(".", r"\.")  # for use inside Flux regex literals (=~ /.../) -- unescaped, "." matches any char
DS = {"type": "influxdb", "uid": "opentwins-influxdb"}


def field(name):
    return f"value_{name}_properties_value"


def target(flux, ref_id="A"):
    return {"refId": ref_id, "datasource": DS, "query": flux}


def panel(id_, type_, title, x, y, w, h, targets, field_defaults=None, options=None, extra=None):
    p = {
        "id": id_,
        "type": type_,
        "title": title,
        "datasource": DS,
        "gridPos": {"x": x, "y": y, "w": w, "h": h},
        "fieldConfig": {"defaults": field_defaults or {}, "overrides": []},
        "options": options or {},
        "targets": targets,
    }
    if extra:
        p.update(extra)
    return p


def stat(id_, title, x, y, flux, unit="none", decimals=0, color="#3a8c9a"):
    return panel(
        id_, "stat", title, x, y, 4, 4, [target(flux)],
        field_defaults={"unit": unit, "decimals": decimals, "color": {"mode": "fixed", "fixedColor": color}},
        options={"reduceOptions": {"calcs": ["lastNotNull"], "fields": "", "values": False},
                 "colorMode": "value", "graphMode": "area", "textMode": "value"},
    )


def timeseries(id_, title, x, y, w, h, targets, unit="none", threshold=None):
    defaults = {"unit": unit, "custom": {"lineWidth": 2, "fillOpacity": 10, "showPoints": "never"}}
    if threshold is not None:
        defaults["custom"]["thresholdsStyle"] = {"mode": "line"}
        defaults["thresholds"] = {"mode": "absolute", "steps": [
            {"color": "transparent", "value": None},
            {"color": "#e5534b", "value": threshold},
        ]}
    return panel(
        id_, "timeseries", title, x, y, w, h, targets,
        field_defaults=defaults,
        options={"legend": {"displayMode": "list", "placement": "bottom"}, "tooltip": {"mode": "multi"}},
    )


def fleet_query(prefix, fields, window="-15m"):
    field_re = "|".join(fields)
    return (
        'import "strings"\n'
        'from(bucket: "default")\n'
        f'  |> range(start: {window})\n'
        f'  |> filter(fn: (r) => r.thingId =~ /^{prefix}/ and r._field =~ /^value_({field_re})_properties_value$/)\n'
        '  |> last()\n'
        '  |> map(fn: (r) => ({thingId: r.thingId, _value: r._value, '
        '_field: strings.trimSuffix(v: strings.trimPrefix(v: r._field, prefix: "value_"), suffix: "_properties_value")}))\n'
        '  |> group(columns: ["thingId"])\n'
        '  |> pivot(rowKey: ["thingId"], columnKey: ["_field"], valueColumn: "_value")\n'
        '  |> group()'
    )


def table(id_, title, x, y, w, h, targets, transformations):
    return panel(
        id_, "table", title, x, y, w, h, targets,
        field_defaults={}, options={"showHeader": True},
        extra={"transformations": transformations},
    )


def main():
    panels = []

    # -- Row 1: shift KPIs (y=0..4) -----------------------------------------
    panels.append(stat(1, "План смены", 0, 0,
        f'from(bucket: "default") |> range(start: v.timeRangeStart, stop: v.timeRangeStop) '
        f'|> filter(fn: (r) => r.thingId == "{NS}:shift-01" and r._field == "{field("plan_completion_pct")}") '
        f'|> keep(columns: ["_time", "_value"])', unit="percent", decimals=0))
    panels.append(stat(2, "Подано на дробилку, т", 4, 0,
        f'from(bucket: "default") |> range(start: v.timeRangeStart, stop: v.timeRangeStop) '
        f'|> filter(fn: (r) => r.thingId == "{NS}:shift-01" and r._field == "{field("tonnes_actual")}") '
        f'|> keep(columns: ["_time", "_value"])', unit="masst", decimals=0))
    panels.append(stat(3, "Содержание Cu в подаче", 8, 0,
        f'from(bucket: "default") |> range(start: v.timeRangeStart, stop: v.timeRangeStop) '
        f'|> filter(fn: (r) => r.thingId == "{NS}:crusher-01" and r._field == "{field("feed_grade")}") '
        f'|> keep(columns: ["_time", "_value"])', unit="percent", decimals=3))
    panels.append(stat(4, "Дробилка сейчас, т/ч", 12, 0,
        f'from(bucket: "default") |> range(start: v.timeRangeStart, stop: v.timeRangeStop) '
        f'|> filter(fn: (r) => r.thingId == "{NS}:crusher-01" and r._field == "{field("throughput_tph")}") '
        f'|> keep(columns: ["_time", "_value"])', unit="none", decimals=0))
    panels.append(stat(5, "Самосвалов активно", 16, 0,
        f'from(bucket: "default") |> range(start: v.timeRangeStart, stop: v.timeRangeStop) '
        f'|> filter(fn: (r) => r.thingId == "{NS}:section-01" and r._field == "{field("trucks_active")}") '
        f'|> keep(columns: ["_time", "_value"])', unit="none", decimals=0))
    panels.append(stat(6, "Минут до конца смены", 20, 0,
        f'from(bucket: "default") |> range(start: v.timeRangeStart, stop: v.timeRangeStop) '
        f'|> filter(fn: (r) => r.thingId == "{NS}:shift-01" and r._field == "{field("time_remaining_min")}") '
        f'|> keep(columns: ["_time", "_value"])', unit="none", decimals=0))

    # -- Row 2: throughput & grade trends, with plan-threshold lines (y=4..12)
    panels.append(timeseries(7, "Подача на дробилку, т/ч (план 2850)", 0, 4, 12, 8, [target(
        f'from(bucket: "default") |> range(start: v.timeRangeStart, stop: v.timeRangeStop) '
        f'|> filter(fn: (r) => r.thingId == "{NS}:crusher-01" and r._field == "{field("throughput_tph")}") '
        f'|> aggregateWindow(every: v.windowPeriod, fn: last, createEmpty: false)'
    )], unit="none", threshold=2850))
    panels.append(timeseries(8, "Содержание Cu в подаче (мин. план 0.38%)", 12, 4, 12, 8, [target(
        f'from(bucket: "default") |> range(start: v.timeRangeStart, stop: v.timeRangeStop) '
        f'|> filter(fn: (r) => r.thingId == "{NS}:crusher-01" and r._field == "{field("feed_grade")}") '
        f'|> aggregateWindow(every: v.windowPeriod, fn: last, createEmpty: false)'
    )], unit="percent", threshold=0.38))

    # -- Row 3: fuel per truck, stockpile buffer (y=12..20) ------------------
    panels.append(timeseries(9, "Топливо по самосвалам, %", 0, 12, 12, 8, [target(
        f'from(bucket: "default") |> range(start: v.timeRangeStart, stop: v.timeRangeStop) '
        f'|> filter(fn: (r) => r.thingId =~ /^{NS_RE}:truck-/ and r._field == "{field("fuel_pct")}") '
        '|> map(fn: (r) => ({_time: r._time, _value: r._value, twin: r.thingId})) '
        '|> group(columns: ["twin"]) '
        '|> aggregateWindow(every: v.windowPeriod, fn: last, createEmpty: false)'
    )], unit="percent"))
    panels.append(timeseries(10, "Рудный склад, т (буфер при остановке дробилки)", 12, 12, 12, 8, [target(
        f'from(bucket: "default") |> range(start: v.timeRangeStart, stop: v.timeRangeStop) '
        f'|> filter(fn: (r) => r.thingId == "{NS}:stockpile-01" and r._field == "{field("tonnes_current")}") '
        f'|> aggregateWindow(every: v.windowPeriod, fn: last, createEmpty: false)'
    )], unit="masst", threshold=5000))

    # -- Row 4: fleet status table (y=20..27) --------------------------------
    truck_prefix = f"{NS_RE}:truck-"
    panels.append(table(
        11, "Самосвалы", 0, 20, 24, 7,
        [
            # pivot() needs a type-homogeneous _value column going in -- split
            # string fields from numeric ones, or it throws a schema collision
            # (found by testing the query directly against InfluxDB, not by
            # inspection: assigned_excavator mixed into the numeric target blew up).
            target(fleet_query(truck_prefix, ["state", "assigned_excavator"]), "A"),
            target(fleet_query(truck_prefix, ["payload_t", "speed_kmh", "fuel_pct", "trips_total"]), "B"),
        ],
        transformations=[
            {"id": "joinByField", "options": {"byField": "thingId", "mode": "outer"}},
            {"id": "organize", "options": {
                "indexByName": {"thingId": 0, "state": 1, "assigned_excavator": 2, "payload_t": 3, "speed_kmh": 4, "fuel_pct": 5, "trips_total": 6},
                "renameByName": {"thingId": "twin", "payload_t": "payload, t", "speed_kmh": "speed, km/h", "fuel_pct": "fuel, %", "trips_total": "trips"},
            }},
        ],
    ))

    # -- Row 5: excavators & roads status (y=27..33) -------------------------
    # Same string/numeric split as the trucks table above -- pivot() needs a
    # type-homogeneous _value column per target.
    exc_prefix = f"{NS_RE}:excavator-"
    panels.append(table(
        12, "Экскаваторы", 0, 27, 12, 6,
        [
            target(fleet_query(exc_prefix, ["state"]), "A"),
            target(fleet_query(exc_prefix, ["tonnes_loaded_shift", "passes_total", "trucks_assigned"]), "B"),
        ],
        transformations=[
            {"id": "joinByField", "options": {"byField": "thingId", "mode": "outer"}},
            {"id": "organize", "options": {
                "indexByName": {"thingId": 0, "state": 1, "trucks_assigned": 2, "passes_total": 3, "tonnes_loaded_shift": 4},
                "renameByName": {"thingId": "twin", "tonnes_loaded_shift": "loaded, t", "trucks_assigned": "trucks"},
            }},
        ],
    ))
    road_prefix = f"{NS_RE}:road-"
    panels.append(table(
        13, "Дороги", 12, 27, 12, 6,
        [
            target(fleet_query(road_prefix, ["state"]), "A"),
            target(fleet_query(road_prefix, ["trucks_on_road"]), "B"),
        ],
        transformations=[
            {"id": "joinByField", "options": {"byField": "thingId", "mode": "outer"}},
            {"id": "organize", "options": {
                "indexByName": {"thingId": 0, "state": 1, "trucks_on_road": 2},
                "renameByName": {"thingId": "twin", "trucks_on_road": "trucks"},
            }},
        ],
    ))

    dashboard = {
        "uid": "team025-pit",
        "title": "Участок медного карьера (team-025)",
        "tags": ["openegiz", "team-025", "mine"],
        "timezone": "browser",
        "schemaVersion": 39,
        "version": 1,
        "refresh": "5s",
        "time": {"from": "now-30m", "to": "now"},
        "description": (
            "Дополнение к 3D-сцене (http://localhost:8091): история по смене, "
            "а не только текущий момент. Данные — org.openegiz.pit, "
            "simulator.py (SimPy) через MQTT -> Ditto -> Telegraf -> InfluxDB."
        ),
        "panels": panels,
    }

    out_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dashboard.json")
    with open(out_path, "w") as f:
        json.dump(dashboard, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print(f"wrote {len(panels)} panels to {out_path}")


if __name__ == "__main__":
    main()
