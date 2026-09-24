from datetime import date, datetime, time, timedelta, timezone

# "Business days before" rather than calendar days — a due date on Monday with a 2-day reminder
# should fire the preceding Thursday, not Saturday (when the user is unlikely to check the app and
# can't act on it anyway — banks/billers aren't processing payments over the weekend either).


_MAX_BUSINESS_DAYS = 60  # matches the DB CHECK constraint on the days unit —
# defense in depth: this loops one day at a time, so an unbounded value would spin a worker thread
# forever inside the reminder cron's asyncio.to_thread call, which asyncio.wait_for's timeout
# cannot actually cancel.

# Caps for the two constant-time units, mirroring bills_reminder_offset_value_in_range. They exist
# to keep a nonsense value from producing a remind-at instant in the distant past (which the grace
# window below would then silently swallow), not to protect against a hot loop.
_MAX_OFFSET_BY_UNIT = {"minutes": 86_400, "hours": 1_440, "days": _MAX_BUSINESS_DAYS}

# How long after its remind-at instant a reminder is still worth sending.
#
# The check is `now >= remind_at`, not `now == remind_at`, because the sweep runs every 5 minutes
# and an equality test would miss essentially every reminder. But an open-ended `>=` means the very
# first sweep would also fire every historical bill whose due date passed months ago — a burst of
# "due soon" notifications about bills that are long overdue, which is both spam and a lie about
# what happened. A bounded window fires anything the sweep genuinely missed (a deploy, a cron
# outage, GitHub Actions running late) and drops anything so stale that a "due soon" reminder would
# be wrong. The cost is explicit and accepted: if nothing sweeps for a full day, that day's
# reminders are lost rather than sent late and misleading.
REMINDER_GRACE = timedelta(days=1)

# A bill's due_date is a DATE with no time component — it comes out of bill emails, which say
# "due 3 October", never "due 3 October at 14:00". "2 hours before the due date" therefore needs an
# anchor instant, and this is it: the LAST instant of the due date, 23:59:59 UTC. Reasoning:
#
#   * End of day rather than start of day, because a bill paid at any point on its due date was
#     paid on time — that is the real deadline the user is being reminded about.
#   * UTC rather than a per-user timezone, because there is no timezone anywhere in this schema
#     (checked: no column on profiles or bills). Inventing one now would mean guessing it, and a
#     guessed timezone silently shifts every reminder. When a real timezone preference exists, this
#     one function is the only place that has to change.
#
# Users who need a reminder at a precise local instant are not served by an offset at all — that is
# exactly what 'exact' mode is for, where the client sends a real timestamptz and none of this
# applies.
def due_instant(due: date) -> datetime:
    return datetime.combine(due, time(23, 59, 59), tzinfo=timezone.utc)


def subtract_business_days(due: date, business_days: int) -> date:
    business_days = max(0, min(business_days, _MAX_BUSINESS_DAYS))
    if business_days <= 0:
        return due
    current = due
    remaining = business_days
    while remaining > 0:
        current -= timedelta(days=1)
        if current.weekday() < 5:  # Monday=0 ... Sunday=6; 5,6 = Sat/Sun
            remaining -= 1
    return current


def compute_remind_at(
    *,
    mode: str,
    due_date: date | None,
    offset_value: int,
    offset_unit: str,
    reminder_at: datetime | None,
) -> datetime | None:
    """The instant a bill's reminder becomes due, or None if it can never fire.

    None (rather than an exception) for the unfireable cases — an offset bill with no due date, an
    exact bill with no instant — because the sweep iterates every unpaid bill in the system and a
    bill nobody set a due date on is an ordinary, expected row, not an error worth logging 288
    times a day.
    """
    if mode == "exact":
        if reminder_at is None:
            return None
        # A naive timestamp would compare unequally against an aware `now` and raise. Postgres
        # always hands back an offset, but a hand-written test value or a hand-patched row might
        # not, and defaulting to UTC matches how every other instant in this service is stored.
        return reminder_at if reminder_at.tzinfo else reminder_at.replace(tzinfo=timezone.utc)

    if due_date is None:
        return None

    unit = offset_unit if offset_unit in _MAX_OFFSET_BY_UNIT else "days"
    value = max(0, min(int(offset_value), _MAX_OFFSET_BY_UNIT[unit]))

    if unit == "days":
        # Whole-day offsets keep the business-day skip AND fire at the start of that day, so the
        # first sweep of the morning delivers them. Subtracting value*24h from due_instant instead
        # would push "2 days before" to 23:59 two evenings earlier — later in the day, useless for
        # acting on, and it would quietly drop the weekend skip that the old daily check had.
        return datetime.combine(subtract_business_days(due_date, value), time(0, 0), tzinfo=timezone.utc)

    delta = timedelta(minutes=value) if unit == "minutes" else timedelta(hours=value)
    return due_instant(due_date) - delta


def reminder_due(remind_at: datetime | None, now: datetime) -> bool:
    if remind_at is None:
        return False
    return remind_at <= now < remind_at + REMINDER_GRACE
