import json
import math
import os
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlparse


SESSION_NAMES = {
    "R": "Race",
    "Q": "Qualifying",
    "SQ": "Sprint Qualifying",
    "S": "Sprint",
    "FP3": "Practice 3",
    "FP2": "Practice 2",
    "FP1": "Practice 1",
}

FALLBACK_EVENTS = {
    "2026": [{"round": 1, "name": "Bahrain Grand Prix"}],
    "2025": [
        {"round": 1, "name": "Australian Grand Prix"},
        {"round": 2, "name": "Chinese Grand Prix"},
        {"round": 3, "name": "Japanese Grand Prix"},
        {"round": 4, "name": "Bahrain Grand Prix"},
        {"round": 5, "name": "Saudi Arabian Grand Prix"},
        {"round": 6, "name": "Miami Grand Prix"},
        {"round": 7, "name": "Emilia Romagna Grand Prix"},
        {"round": 8, "name": "Monaco Grand Prix"},
        {"round": 9, "name": "Spanish Grand Prix"},
        {"round": 10, "name": "Canadian Grand Prix"},
        {"round": 11, "name": "Austrian Grand Prix"},
        {"round": 12, "name": "British Grand Prix"},
        {"round": 13, "name": "Belgian Grand Prix"},
        {"round": 14, "name": "Hungarian Grand Prix"},
        {"round": 15, "name": "Dutch Grand Prix"},
        {"round": 16, "name": "Italian Grand Prix"},
        {"round": 17, "name": "Azerbaijan Grand Prix"},
        {"round": 18, "name": "Singapore Grand Prix"},
        {"round": 19, "name": "United States Grand Prix"},
        {"round": 20, "name": "Mexico City Grand Prix"},
        {"round": 21, "name": "Sao Paulo Grand Prix"},
        {"round": 22, "name": "Las Vegas Grand Prix"},
        {"round": 23, "name": "Qatar Grand Prix"},
        {"round": 24, "name": "Abu Dhabi Grand Prix"},
    ],
}


def json_response(handler, status, payload):
    body = json.dumps(payload, allow_nan=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.send_header("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def clean(value):
    if value is None:
        return None
    try:
        if hasattr(value, "item"):
            value = value.item()
    except Exception:
        pass
    if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
        return None
    if str(type(value)).endswith("NaTType'>"):
        return None
    return value


def format_duration(value):
    value = clean(value)
    if value is None:
        return None
    if hasattr(value, "total_seconds"):
        total = value.total_seconds()
    else:
        try:
            total = float(value)
        except (TypeError, ValueError):
            return str(value)
    if not math.isfinite(total) or total <= 0:
        return None
    minutes = int(total // 60)
    seconds = total - (minutes * 60)
    return f"{minutes}:{seconds:06.3f}" if minutes else f"{seconds:.3f}"


def scalar(row, key):
    try:
        return clean(row.get(key))
    except Exception:
        return None


def get_fastf1():
    import fastf1

    cache_dir = os.environ.get("FASTF1_CACHE_DIR", "/tmp/fastf1-cache")
    os.makedirs(cache_dir, exist_ok=True)
    fastf1.Cache.enable_cache(cache_dir)
    return fastf1


def schedule_for_year(fastf1, year):
    schedule = fastf1.get_event_schedule(year, include_testing=False)
    today = datetime.now(timezone.utc).date()
    events = []
    for _, event in schedule.iterrows():
        round_number = int(clean(event.get("RoundNumber")) or 0)
        event_name = clean(event.get("EventName"))
        event_date = clean(event.get("EventDate"))
        if not round_number or not event_name:
            continue
        if hasattr(event_date, "date") and event_date.date() > today:
            continue
        events.append({"round": round_number, "name": event_name})
    return events


def options_payload():
    try:
        fastf1 = get_fastf1()
        seasons = [2026, 2025, 2024, 2023, 2022, 2021]
        events_by_season = {}
        for season in seasons:
            events = schedule_for_year(fastf1, season)
            if events:
                events_by_season[str(season)] = events
        if events_by_season:
            return {
                "source": "session-data",
                "seasons": [int(year) for year in events_by_season.keys()],
                "events_by_season": events_by_season,
            }
    except Exception:
        pass

    return {
        "source": "fallback",
        "seasons": [int(year) for year in FALLBACK_EVENTS.keys()],
        "events_by_season": FALLBACK_EVENTS,
    }


def driver_name(session, abbreviation):
    try:
        info = session.get_driver(abbreviation)
        return clean(info.get("FullName")) or abbreviation
    except Exception:
        return abbreviation


def build_driver_summary(session, laps):
    drivers = []
    for abbreviation in sorted([item for item in laps["Driver"].dropna().unique()]):
        driver_laps = laps[laps["Driver"] == abbreviation]
        quickest = driver_laps.pick_fastest()
        drivers.append({
            "code": abbreviation,
            "name": driver_name(session, abbreviation),
            "team": clean(scalar(quickest, "Team")),
            "team_color": None,
            "best_lap": format_duration(scalar(quickest, "LapTime")),
            "average_lap": format_duration(driver_laps["LapTime"].dropna().mean()),
            "laps": int(driver_laps["LapNumber"].max() or len(driver_laps)),
        })
    return drivers


def build_podium(results):
    if results is None or results.empty:
        return []
    rows = []
    for _, row in results.sort_values("Position").head(3).iterrows():
        rows.append({
            "position": int(clean(row.get("Position")) or len(rows) + 1),
            "driver": clean(row.get("Abbreviation")) or clean(row.get("FullName")),
            "name": clean(row.get("FullName")) or clean(row.get("Abbreviation")),
            "team": clean(row.get("TeamName")),
            "time": str(clean(row.get("Time")) or clean(row.get("Status")) or ""),
        })
    return rows


def build_lap_rows(laps):
    quick = laps.dropna(subset=["LapTime"]).sort_values("LapTime").head(80)
    rows = []
    for _, lap in quick.iterrows():
        rows.append({
            "driver": clean(lap.get("Driver")),
            "lap_number": int(clean(lap.get("LapNumber")) or 0),
            "lap_time": format_duration(lap.get("LapTime")),
            "sector_1": format_duration(lap.get("Sector1Time")),
            "sector_2": format_duration(lap.get("Sector2Time")),
            "sector_3": format_duration(lap.get("Sector3Time")),
            "compound": clean(lap.get("Compound")),
        })
    return rows


def sample_rows(frame, limit=90):
    if frame is None or frame.empty:
        return []
    if len(frame) <= limit:
        return frame
    step = max(1, len(frame) // limit)
    return frame.iloc[::step].head(limit)


def fastest_lap_number(laps, driver):
    try:
        driver_laps = laps[laps["Driver"] == driver].dropna(subset=["LapTime"])
        if driver_laps.empty:
            return None
        fastest = driver_laps.pick_fastest()
        return int(clean(fastest.get("LapNumber")) or 0)
    except Exception:
        return None


def build_lap_options(laps):
    options = {}
    if laps.empty or "Driver" not in laps.columns:
        return options
    for driver in sorted(laps["Driver"].dropna().unique()):
        driver_laps = laps[laps["Driver"] == driver].dropna(subset=["LapNumber"])
        lap_numbers = sorted({int(clean(lap) or 0) for lap in driver_laps["LapNumber"] if clean(lap)})
        options[clean(driver)] = {
            "laps": lap_numbers,
            "fastest_lap": fastest_lap_number(laps, driver),
        }
    return options


def selected_trace_specs(laps, query):
    available = [clean(item) for item in laps["Driver"].dropna().unique()]
    available = [item for item in available if item]
    defaults = available[:2]
    specs = []
    for index, suffix in enumerate(("a", "b")):
        driver = clean(query.get(f"driver_{suffix}", [defaults[index] if index < len(defaults) else None])[0])
        if not driver or driver not in available:
            continue
        requested_lap = clean(query.get(f"lap_{suffix}", [""])[0])
        lap_number = int(requested_lap) if str(requested_lap).isdigit() else fastest_lap_number(laps, driver)
        specs.append({"driver": driver, "lap_number": lap_number})
    return specs


def pick_driver_lap(laps, driver, lap_number):
    driver_laps = laps[laps["Driver"] == driver]
    if lap_number:
        exact = driver_laps[driver_laps["LapNumber"] == lap_number]
        if not exact.empty:
            return exact.iloc[0]
    return driver_laps.dropna(subset=["LapTime"]).pick_fastest()


def build_telemetry_traces(laps, specs):
    traces = []
    if laps.empty:
        return traces
    for spec in specs:
        code = spec.get("driver")
        try:
            lap = pick_driver_lap(laps, code, spec.get("lap_number"))
            car_data = lap.get_car_data().add_distance()
            points = []
            for _, row in sample_rows(car_data).iterrows():
                points.append({
                    "distance": round(float(clean(row.get("Distance")) or 0), 1),
                    "speed": clean(row.get("Speed")),
                    "throttle": clean(row.get("Throttle")),
                    "brake": 100 if clean(row.get("Brake")) else 0,
                    "gear": clean(row.get("nGear")),
                    "rpm": clean(row.get("RPM")),
                })
            if points:
                traces.append({
                    "driver": code,
                    "lap_number": int(clean(lap.get("LapNumber")) or 0),
                    "lap_time": format_duration(lap.get("LapTime")),
                    "points": points,
                })
        except Exception:
            continue
    return traces


def build_track_maps(laps, specs):
    if laps.empty:
        return {"points": [], "drivers": [], "maps": []}
    maps = []
    for spec in specs[:2]:
        try:
            lap = pick_driver_lap(laps, spec.get("driver"), spec.get("lap_number"))
            pos_data = lap.get_pos_data()
            points = []
            for _, row in sample_rows(pos_data, 140).iterrows():
                x = clean(row.get("X"))
                y = clean(row.get("Y"))
                if x is None or y is None:
                    continue
                points.append({"x": round(float(x), 2), "y": round(float(y), 2)})
            if points:
                maps.append({
                    "driver": clean(lap.get("Driver")),
                    "lap_number": int(clean(lap.get("LapNumber")) or 0),
                    "points": points,
                })
        except Exception:
            continue
    primary = maps[0] if maps else {"points": []}
    return {
        "points": primary.get("points", []),
        "drivers": [{"driver": item["driver"], "lap_number": item["lap_number"]} for item in maps],
        "maps": maps,
    }


def build_position_changes(laps):
    if "Position" not in laps.columns or laps.empty:
        return []
    rows = []
    for driver in sorted(laps["Driver"].dropna().unique()):
        driver_laps = laps[laps["Driver"] == driver].dropna(subset=["LapNumber", "Position"])
        points = []
        for _, lap in driver_laps.sort_values("LapNumber").iterrows():
            points.append({
                "lap": int(clean(lap.get("LapNumber")) or 0),
                "position": int(clean(lap.get("Position")) or 0),
            })
        if points:
            rows.append({"driver": clean(driver), "points": points})
    return rows[:20]


def build_stints(laps):
    rows = []
    required = {"Driver", "Compound", "Stint", "LapNumber"}
    if not required.issubset(set(laps.columns)):
        return rows
    grouped = laps.dropna(subset=["Driver", "Compound", "Stint", "LapNumber"]).groupby(["Driver", "Stint", "Compound"])
    for (driver, _, compound), stint_laps in grouped:
        rows.append({
            "driver": clean(driver),
            "compound": clean(compound),
            "start_lap": int(stint_laps["LapNumber"].min()),
            "end_lap": int(stint_laps["LapNumber"].max()),
        })
    return rows[:40]


def build_pit_events(laps):
    events = []
    required = {"Driver", "LapNumber", "PitInTime", "PitOutTime"}
    if not required.issubset(set(laps.columns)):
        return events
    pit_laps = laps[laps["PitInTime"].notna() | laps["PitOutTime"].notna()]
    for _, lap in pit_laps.iterrows():
        events.append({
            "driver": clean(lap.get("Driver")),
            "lap": int(clean(lap.get("LapNumber")) or 0),
            "in_time": str(clean(lap.get("PitInTime")) or ""),
            "out_time": str(clean(lap.get("PitOutTime")) or ""),
        })
    return events[:50]


def build_weather(session):
    weather = getattr(session, "weather_data", None)
    if weather is None or weather.empty:
        return {"source": "unavailable"}
    sample = weather.iloc[len(weather) // 2]
    return {
        "source": "mid-session",
        "air_temperature": f"{clean(sample.get('AirTemp'))} C" if clean(sample.get("AirTemp")) is not None else None,
        "track_temperature": f"{clean(sample.get('TrackTemp'))} C" if clean(sample.get("TrackTemp")) is not None else None,
        "humidity": f"{clean(sample.get('Humidity'))}%" if clean(sample.get("Humidity")) is not None else None,
        "rainfall": "yes" if clean(sample.get("Rainfall")) else "no",
    }


def build_messages(session):
    messages = getattr(session, "race_control_messages", None)
    if messages is None or messages.empty:
        return []
    rows = []
    for _, msg in messages.tail(20).iterrows():
        rows.append({
            "time": str(clean(msg.get("Time")) or ""),
            "message": clean(msg.get("Message")) or clean(msg.get("Category")),
        })
    return rows


def message_count(messages, needle):
    return sum(1 for item in messages if needle in (item.get("message") or "").upper())


def analytics_payload(query):
    season = int(query.get("season", ["2025"])[0] or 2025)
    round_number = int(query.get("round", ["24"])[0] or 24)
    session_code = query.get("session", ["R"])[0] or "R"
    session_name = SESSION_NAMES.get(session_code, session_code)

    try:
        fastf1 = get_fastf1()
        session = fastf1.get_session(season, round_number, session_code)
        session.load(laps=True, telemetry=True, weather=True, messages=True)
        laps = session.laps
        fastest = laps.pick_fastest()
        trace_specs = selected_trace_specs(laps, query)
        drivers = build_driver_summary(session, laps)
        lap_rows = build_lap_rows(laps)
        stints = build_stints(laps)
        messages = build_messages(session)
        safety_cars = message_count(messages, "SAFETY CAR")
        winner = drivers[0]["name"] if drivers else None
        winner_team = drivers[0]["team"] if drivers else None
        results = getattr(session, "results", None)
        podium = build_podium(results)
        race_duration = None
        if results is not None and not results.empty:
            top = results.sort_values("Position").iloc[0]
            winner = clean(top.get("FullName")) or clean(top.get("Abbreviation")) or winner
            winner_team = clean(top.get("TeamName")) or winner_team
            race_duration = str(clean(top.get("Time")) or "")

        total_laps = int(laps["LapNumber"].max()) if not laps.empty else None
        weather = build_weather(session)
        event = getattr(session, "event", {})
        event_name = clean(event.get("EventName")) if hasattr(event, "get") else None
        pit_events = build_pit_events(laps)
        yellow_flags = message_count(messages, "YELLOW")

        return {
            "source": "session-data",
            "season": season,
            "round": round_number,
            "event_name": event_name or f"Round {round_number}",
            "session_name": session_name,
            "overview": {
                "winner": winner,
                "winner_team": winner_team,
                "podium": podium,
                "fastest_lap_driver": clean(scalar(fastest, "Driver")),
                "fastest_lap_time": format_duration(scalar(fastest, "LapTime")),
                "safety_cars": safety_cars,
                "weather_summary": weather.get("track_temperature") or weather.get("source"),
                "air_track_summary": weather.get("air_temperature"),
                "total_laps": total_laps,
                "race_duration": race_duration,
                "session_name": session_name,
            },
            "drivers": drivers,
            "lap_options": build_lap_options(laps),
            "selected_traces": trace_specs,
            "laps": lap_rows,
            "stints": stints,
            "telemetry_traces": build_telemetry_traces(laps, trace_specs),
            "position_changes": build_position_changes(laps),
            "track_map": build_track_maps(laps, trace_specs),
            "pit_events": pit_events,
            "event_summary": {
                "pit_stops": len(pit_events),
                "yellow_flags": yellow_flags,
                "safety_cars": safety_cars,
            },
            "weather": weather,
            "race_control": messages,
        }
    except Exception as exc:
        return fallback_analytics(season, round_number, session_name, str(exc))


def fallback_analytics(season, round_number, session_name, reason=None):
    event_name = next(
        (event["name"] for event in FALLBACK_EVENTS.get(str(season), []) if event["round"] == round_number),
        f"Round {round_number}",
    )
    return {
        "source": "fallback",
        "error": reason,
        "season": season,
        "round": round_number,
        "event_name": event_name,
        "session_name": session_name,
        "overview": {
            "winner": None,
            "winner_team": None,
            "fastest_lap_driver": None,
            "fastest_lap_time": None,
            "safety_cars": None,
            "weather_summary": "Data unavailable",
            "air_track_summary": "Try another completed session",
            "total_laps": None,
            "race_duration": None,
            "session_name": session_name,
        },
        "drivers": [],
        "lap_options": {},
        "selected_traces": [],
        "laps": [],
        "stints": [],
        "telemetry_traces": [],
        "position_changes": [],
        "track_map": {"points": [], "drivers": []},
        "pit_events": [],
        "event_summary": {"pit_stops": 0, "yellow_flags": 0, "safety_cars": 0},
        "weather": {"source": "unavailable"},
        "race_control": [],
    }


class handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        query = parse_qs(urlparse(self.path).query)
        if query.get("mode", [""])[0] == "options":
            json_response(self, 200, options_payload())
            return
        json_response(self, 200, analytics_payload(query))
