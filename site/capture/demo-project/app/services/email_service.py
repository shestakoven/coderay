import smtplib
from email.message import EmailMessage

from app.models.user import User

SMTP_TIMEOUT_S = 10

WELCOME = """Hi {name},

Welcome to Acme! Your account is ready.

The Acme team
"""


class EmailService:
    def __init__(self, host: str, sender: str) -> None:
        self.host = host
        self.sender = sender

    def send_welcome(self, user: User) -> None:
        message = EmailMessage()
        message["From"] = self.sender
        message["To"] = user.email
        message["Subject"] = "Welcome to Acme"
        message.set_content(WELCOME.format(name=user.name))
        self._deliver(message)

    def _deliver(self, message: EmailMessage) -> None:
        with smtplib.SMTP(self.host, timeout=SMTP_TIMEOUT_S) as smtp:
            smtp.send_message(message)
