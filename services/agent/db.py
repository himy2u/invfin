import os
from functools import lru_cache

from supabase import Client, create_client


@lru_cache(maxsize=1)
def get_service_client() -> Client:
    # Service-role key — bypasses RLS entirely. Only for server-to-server paths that have no user
    # JWT (inbound email webhook, reminder cron). Every other DB access in this codebase goes
    # through a per-user, RLS-scoped client on the Node/Next side; this is the agent service's only
    # privileged path and it must stay that way — never reuse this client for anything a normal
    # authenticated RPC could do instead.
    # NEXT_PUBLIC_SUPABASE_URL is the project URL, not a secret — reusing it here (rather than
    # requiring a second, differently-named env var) avoids a duplicate value that could drift.
    url = os.environ["NEXT_PUBLIC_SUPABASE_URL"]
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    return create_client(url, key)
