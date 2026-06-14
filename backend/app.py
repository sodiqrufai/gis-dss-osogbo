from flask import Flask, jsonify, request
from flask_cors import CORS
from sqlalchemy import create_engine, text
import pandas as pd
import json
import os
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__)
CORS(app)

# Build DB URL from environment variables
DB_URL="postgresql://postgres.hfiynpnobxeigevxmoji:Siju_ade2004@aws-0-eu-west-1.pooler.supabase.com:5432/postgres"
engine = create_engine(DB_URL)


def postgis_to_geojson(rows, columns):
    """Convert PostGIS query results to GeoJSON FeatureCollection."""
    features = []
    for row in rows:
        row_dict = dict(zip(columns, row))
        geom = row_dict.pop('geom', None)
        feature = {
            "type": "Feature",
            "geometry": json.loads(geom) if geom else None,
            "properties": {k: (float(v) if hasattr(v, 'real') else v)
                          for k, v in row_dict.items()
                          if v is not None or k != 'geom'}
        }
        features.append(feature)
    return {"type": "FeatureCollection", "features": features}


@app.route("/")
def home():
    return jsonify({
        "message": "GIS-DSS API for Business Location Selection in Osogbo",
        "status": "live",
        "endpoints": {
            "/api/suitability":              "GET - all suitability zones as GeoJSON",
            "/api/suitability/top":          "GET - top N zones (param: n)",
            "/api/recommend?type=<cat>":     "GET - business-type-adjusted suitability",
            "/api/roads":                    "GET - road network as GeoJSON",
            "/api/pois":                     "GET - business POIs as GeoJSON",
            "/api/ahp-criteria":             "GET - AHP criteria and weights",
            "/api/stats":                    "GET - summary statistics"
        }
    })


@app.route("/api/suitability")
def get_suitability():
    with engine.connect() as conn:
        result = conn.execute(text("""
            SELECT score_id, zone_id, business_type, ahp_score, ml_score,
                   composite_score, ST_AsGeoJSON(geom) as geom
            FROM suitability_score
            ORDER BY composite_score DESC
        """))
        rows = result.fetchall()
        cols = result.keys()
    return jsonify(postgis_to_geojson(rows, cols))


@app.route("/api/suitability/top")
def get_top_suitability():
    n = request.args.get("n", default=10, type=int)
    with engine.connect() as conn:
        result = conn.execute(text(f"""
            SELECT score_id, zone_id, business_type, ahp_score, ml_score,
                   composite_score, ST_AsGeoJSON(geom) as geom
            FROM suitability_score
            ORDER BY composite_score DESC
            LIMIT {n}
        """))
        rows = result.fetchall()
        cols = result.keys()
    return jsonify(postgis_to_geojson(rows, cols))


@app.route("/api/recommend")
def recommend():
    business_type = request.args.get("type", default="", type=str).strip()
    category_param = business_type if business_type else "__none__"

    with engine.connect() as conn:
        result = conn.execute(text("""
            SELECT
                s.score_id, s.zone_id, s.business_type, s.ahp_score,
                s.ml_score, s.composite_score,
                COALESCE(c.competitor_count, 0) AS competitor_count,
                ST_AsGeoJSON(s.geom) as geom
            FROM suitability_score s
            LEFT JOIN (
                SELECT z.zone_id, COUNT(p.poi_id) AS competitor_count
                FROM land_use_zone z
                JOIN business_poi p ON ST_Within(p.geom, z.geom)
                WHERE p.category = :category
                GROUP BY z.zone_id
            ) c ON s.zone_id = c.zone_id
            ORDER BY s.composite_score DESC
        """), {"category": category_param})
        rows = result.fetchall()
        cols = list(result.keys())

    PENALTY_PER_COMPETITOR = 8
    MAX_PENALTY = 40

    features = []
    for row in rows:
        row_dict = dict(zip(cols, row))
        geom = row_dict.pop('geom', None)
        competitor_count = row_dict.get('competitor_count', 0) or 0

        if business_type:
            penalty = min(competitor_count * PENALTY_PER_COMPETITOR, MAX_PENALTY)
        else:
            penalty = 0

        adjusted_score = max(0, (row_dict.get('composite_score') or 0) - penalty)
        row_dict['penalty'] = penalty
        row_dict['adjusted_score'] = adjusted_score

        props = {k: (float(v) if hasattr(v, 'real') else v)
                 for k, v in row_dict.items()}

        features.append({
            "type": "Feature",
            "geometry": json.loads(geom) if geom else None,
            "properties": props
        })

    features.sort(key=lambda f: f['properties']['adjusted_score'], reverse=True)
    return jsonify({"type": "FeatureCollection", "features": features})


@app.route("/api/roads")
def get_roads():
    with engine.connect() as conn:
        result = conn.execute(text("""
            SELECT road_id, road_class, name, ST_AsGeoJSON(geom) as geom
            FROM road_network
            WHERE road_class IN ('primary', 'trunk', 'secondary', 'tertiary')
        """))
        rows = result.fetchall()
        cols = result.keys()
    return jsonify(postgis_to_geojson(rows, cols))


@app.route("/api/pois")
def get_pois():
    with engine.connect() as conn:
        result = conn.execute(text("""
            SELECT poi_id, name, category, source, ST_AsGeoJSON(geom) as geom
            FROM business_poi
        """))
        rows = result.fetchall()
        cols = result.keys()
    return jsonify(postgis_to_geojson(rows, cols))


@app.route("/api/ahp-criteria")
def get_ahp_criteria():
    with engine.connect() as conn:
        result = conn.execute(text(
            "SELECT criteria_id, criteria_name, category, weight FROM ahp_criteria"
        ))
        rows = [dict(zip(result.keys(), row)) for row in result.fetchall()]
    return jsonify(rows)


@app.route("/api/stats")
def get_stats():
    with engine.connect() as conn:
        zones = conn.execute(text("SELECT COUNT(*) FROM land_use_zone")).scalar()
        pois  = conn.execute(text("SELECT COUNT(*) FROM business_poi")).scalar()
        roads = conn.execute(text("SELECT COUNT(*) FROM road_network")).scalar()
        scores = conn.execute(text(
            "SELECT MIN(composite_score), MAX(composite_score), AVG(composite_score) "
            "FROM suitability_score"
        )).fetchone()

    return jsonify({
        "total_zones":          zones,
        "total_pois":           pois,
        "total_road_segments":  roads,
        "suitability_min":      round(float(scores[0]), 2) if scores[0] else None,
        "suitability_max":      round(float(scores[1]), 2) if scores[1] else None,
        "suitability_avg":      round(float(scores[2]), 2) if scores[2] else None,
    })


if __name__ == "__main__":
    port = int(os.getenv("PORT", 5000))
    app.run(debug=False, host="0.0.0.0", port=port)