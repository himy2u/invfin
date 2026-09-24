import os

import httpx
from fastapi import APIRouter, HTTPException

from db import get_service_client
from logging_setup import logger

router = APIRouter()

# Fixed to the one real account with real detected bills, so testers on the same network see actual
# data (a real British Gas bill, etc.) rather than an empty account — closer to what a real user's
# experience looks like than a fresh synthetic account would be.
_TEST_EMAIL = os.environ.get("DEV_TEST_LOGIN_EMAIL", "humanrav@gmail.com")


@router.post("/dev/test-session")
async def dev_test_session() -> dict[str, str]:
    # Mounted only when ENABLE_DEV_TEST_LOGIN is set (see main.py) — never set on the deployed
    # Render service, so this endpoint doesn't exist in production regardless of who calls it.
    service_client = get_service_client()
    try:
        link_response = service_client.auth.admin.generate_link(
            {"type": "magiclink", "email": _TEST_EMAIL}
        )
    except Exception as exc:
        logger.error("dev test session generate_link failed", error=str(exc))
        raise HTTPException(502, "could not mint test session") from exc

    email_otp = link_response.properties.email_otp
    supabase_url = os.environ["NEXT_PUBLIC_SUPABASE_URL"]
    anon_key = os.environ["NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"]

    async with httpx.AsyncClient() as client:
        verify_response = await client.post(
            f"{supabase_url}/auth/v1/verify",
            headers={"apikey": anon_key, "Content-Type": "application/json"},
            json={"type": "magiclink", "email": _TEST_EMAIL, "token": email_otp},
        )
    if verify_response.status_code != 200:
        logger.error(
            "dev test session verify failed",
            status=verify_response.status_code,
            body=verify_response.text,
        )
        raise HTTPException(502, "could not verify test session")

    session = verify_response.json()
    return {"access_token": session["access_token"], "refresh_token": session["refresh_token"]}
