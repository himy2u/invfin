import httpx

from logging_setup import logger

_EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send"


def send_push_notification(expo_push_token: str, title: str, body: str) -> bool:
    # Deliberately swallows its own errors (logs and returns rather than raising) — this is called
    # alongside the email/in-app notification writes for the same event, and a dead/expired push
    # token or a transient Expo outage must never block or roll back the other two channels. Push
    # is the least essential of the three by design (see reminder_scheduling.py callers).
    #
    # Returns whether the send actually went through, so the "send a test reminder" path can tell
    # the user the truth about this channel instead of assuming it worked. Callers that don't care
    # (the real reminder cron) ignore the value and behave exactly as before.
    try:
        response = httpx.post(
            _EXPO_PUSH_URL,
            json={"to": expo_push_token, "title": title, "body": body, "sound": "default"},
            headers={"Content-Type": "application/json", "Accept": "application/json"},
            timeout=10,
        )
        response.raise_for_status()
        logger.info("push notification sent", token_prefix=expo_push_token[:12])
        return True
    except Exception as exc:
        logger.warning("push notification failed", error=str(exc))
        return False
