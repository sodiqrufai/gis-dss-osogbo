from flask import Flask, jsonify, request
from flask_cors import CORS
from sqlalchemy import create_engine, text
import geopandas as gpd
import pandas as pd

from config import Config

app = Flask(__name__)
CORS(app)

engine = create_engine(Config.SQLALCHEMY_DATABASE_URI)


@app.route("/")
def home():
    return jsonify({
        "message": "GIS-DSS API for Business Location Selection in Osogbo",
        "endpoints": {
            "/api/suitability": "GET - all suitability zones as GeoJSON (general)",
            "/api/recommend?type=<category>": "GET - business-type-adjusted suitability",
            "/api/roads": "GET - road network as GeoJSON",
            "/api/pois": "GET - business POIs as GeoJSON",
            "/api/ahp-criteria": "GET - current AHP criteria and weights",
            "/api/stats": "GET - summary statistics"
        }
    })


@app.route("/api/suitability")
def get_suitability():
    gdf = gpd.read_postgis(
        "SELECT score_id, zone_id, business_type, ahp_score, ml_score, "
        "composite_score, geom FROM suitability_score ORDER BY composite_score DESC",
        engine, geom_col="geom"
    )
    return gdf.to_json()


@app.route("/api/recommend")
def recommend():
    """
    Return suitability for every zone, adjusted for a specific business type.

    If 'type' is empty, adjusted_score == composite_score (no penalty).
    If 'type' is provided, each zone's score is penalized based on how many
    existing businesses of that category already operate within the zone
    (market saturation penalty).
    """
    business_type = request.args.get("type", default="", type=str).strip()

    base_query = """
        SELECT 
            s.score_id, s.zone_id, s.business_type, s.ahp_score, 
            s.ml_score, s.composite_score, s.geom,
            COALESCE(c.competitor_count, 0) AS competitor_count
        FROM suitability_score s
        LEFT JOIN (
            SELECT z.zone_id, COUNT(p.poi_id) AS competitor_count
            FROM land_use_zone z
            JOIN business_poi p ON ST_Within(p.geom, z.geom)
            WHERE p.category = :category
            GROUP BY z.zone_id
        ) c ON s.zone_id = c.zone_id
    """

    # Use a category that will never match if none was selected,
    # so competitor_count is always 0 and the join is harmless.
    category_param = business_type if business_type else "__none__"

    gdf = gpd.read_postgis(
        text(base_query), engine, geom_col="geom",
        params={"category": category_param}
    )

    PENALTY_PER_COMPETITOR = 8
    MAX_PENALTY = 40

    if business_type:
        gdf['penalty'] = (gdf['competitor_count'] * PENALTY_PER_COMPETITOR).clip(upper=MAX_PENALTY)
    else:
        gdf['penalty'] = 0

    gdf['adjusted_score'] = (gdf['composite_score'] - gdf['penalty']).clip(lower=0)
    gdf = gdf.sort_values('adjusted_score', ascending=False).reset_index(drop=True)

    return gdf.to_json()


@app.route("/api/roads")
def get_roads():
    road_class = request.args.get("class")
    if road_class:
        query = text("SELECT road_id, road_class, name, geom FROM road_network WHERE road_class = :rc")
        gdf = gpd.read_postgis(query, engine, geom_col="geom", params={"rc": road_class})
    else:
        query = """
            SELECT road_id, road_class, name, geom FROM road_network 
            WHERE road_class IN ('primary', 'trunk', 'secondary', 'tertiary')
        """
        gdf = gpd.read_postgis(query, engine, geom_col="geom")
    return gdf.to_json()


@app.route("/api/pois")
def get_pois():
    gdf = gpd.read_postgis(
        "SELECT poi_id, name, category, source, geom FROM business_poi",
        engine, geom_col="geom"
    )
    return gdf.to_json()


@app.route("/api/ahp-criteria")
def get_ahp_criteria():
    df = pd.read_sql("SELECT criteria_id, criteria_name, category, weight FROM ahp_criteria", engine)
    return jsonify(df.to_dict(orient="records"))


@app.route("/api/stats")
def get_stats():
    with engine.connect() as conn:
        zones = conn.execute(text("SELECT COUNT(*) FROM land_use_zone")).scalar()
        pois = conn.execute(text("SELECT COUNT(*) FROM business_poi")).scalar()
        roads = conn.execute(text("SELECT COUNT(*) FROM road_network")).scalar()
        scores = conn.execute(text(
            "SELECT MIN(composite_score), MAX(composite_score), AVG(composite_score) "
            "FROM suitability_score"
        )).fetchone()

    return jsonify({
        "total_zones": zones,
        "total_pois": pois,
        "total_road_segments": roads,
        "suitability_min": round(scores[0], 2) if scores[0] else None,
        "suitability_max": round(scores[1], 2) if scores[1] else None,
        "suitability_avg": round(scores[2], 2) if scores[2] else None,
    })


if __name__ == "__main__":
    app.run(debug=True, port=5000)