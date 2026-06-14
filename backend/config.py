import os

class Config:
    DB_HOST = "localhost"
    DB_PORT = "5432"
    DB_NAME = "gis_dss"
    DB_USER = "postgres"
    DB_PASSWORD = "sijuade2004"  # your actual password

    SQLALCHEMY_DATABASE_URI = f"postgresql://{DB_USER}:{DB_PASSWORD}@{DB_HOST}:{DB_PORT}/{DB_NAME}"