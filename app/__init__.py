import os

from flask import Flask
from flask_socketio import SocketIO

from app.config import Config

socketio = SocketIO(cors_allowed_origins="*", async_mode="threading")

_BASE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


def create_app(config_class=Config):
    app = Flask(
        __name__,
        static_folder=os.path.join(_BASE_DIR, "static"),
        template_folder=os.path.join(_BASE_DIR, "templates"),
    )
    app.config.from_object(config_class)

    from app.routes.pages import pages_bp
    from app.routes.api import api_bp

    app.register_blueprint(pages_bp)
    app.register_blueprint(api_bp, url_prefix="/api")

    from app import signaling  # noqa: F401

    socketio.init_app(app)
    return app
