import os
from . import util
from .db import connect
from app.models import User


def run():
    return connect(User(), os.getcwd(), util.helper())
