import logging

from app import create_app, socketio
from app.config import Config

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)

app = create_app()

if __name__ == "__main__":
    socketio.run(app, host=Config.HOST, port=Config.PORT, allow_unsafe_werkzeug=True)
