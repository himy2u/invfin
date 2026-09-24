from datetime import date, datetime, timedelta, timezone

from reminder_scheduling import (
    REMINDER_GRACE,
    compute_remind_at,
    due_instant,
    reminder_due,
    subtract_business_days,
)


def _utc(y: int, m: int, d: int, hh: int = 0, mm: int = 0, ss: int = 0) -> datetime:
    return datetime(y, m, d, hh, mm, ss, tzinfo=timezone.utc)


def _offset(due: date | None, value: int, unit: str) -> datetime | None:
    return compute_remind_at(mode="offset", due_date=due, offset_value=value, offset_unit=unit, reminder_at=None)


def test_subtract_business_days_within_week() -> None:
    # Wednesday minus 2 business days = Monday (no weekend in between)
    assert subtract_business_days(date(2026, 9, 23), 2) == date(2026, 9, 21)


def test_subtract_business_days_crosses_weekend() -> None:
    # Monday minus 2 business days should land on the preceding Thursday, skipping Sat/Sun
    assert subtract_business_days(date(2026, 9, 21), 2) == date(2026, 9, 17)


def test_subtract_business_days_zero_returns_due_date() -> None:
    assert subtract_business_days(date(2026, 9, 21), 0) == date(2026, 9, 21)


def test_due_instant_is_end_of_the_due_day_in_utc() -> None:
    assert due_instant(date(2026, 10, 3)) == _utc(2026, 10, 3, 23, 59, 59)


# --- offset mode: days ------------------------------------------------------------------------
# The migrated shape of every pre-existing row (reminder_days_before: N -> N, 'days'), so these
# double as the data-migration conversion tests: a bill that was `reminder_days_before: 2` must
# still fire on exactly the day the old business-day logic picked.


def test_days_offset_keeps_the_business_day_skip_and_fires_at_start_of_day() -> None:
    # due Monday 2026-09-21, 2 days before -> Thursday 2026-09-17, 00:00 UTC
    assert _offset(date(2026, 9, 21), 2, "days") == _utc(2026, 9, 17)


def test_migrated_two_day_row_is_due_on_its_old_day_and_not_before() -> None:
    remind_at = _offset(date(2026, 9, 21), 2, "days")
    assert reminder_due(remind_at, _utc(2026, 9, 16, 23, 59)) is False  # the evening before
    assert reminder_due(remind_at, _utc(2026, 9, 17, 0, 5)) is True  # first sweep of that morning
    assert reminder_due(remind_at, _utc(2026, 9, 17, 17, 0)) is True  # still that day


def test_zero_day_offset_fires_on_the_due_date_itself() -> None:
    assert _offset(date(2026, 9, 21), 0, "days") == _utc(2026, 9, 21)


def test_days_offset_is_clamped_to_the_db_ceiling() -> None:
    # Guards the unbounded-loop hazard subtract_business_days has; 999 must not walk 999 iterations
    # past the 60-day cap.
    assert _offset(date(2026, 9, 21), 999, "days") == _offset(date(2026, 9, 21), 60, "days")


# --- offset mode: hours and minutes -----------------------------------------------------------


def test_one_hour_before_due_date_is_an_hour_before_end_of_the_due_day() -> None:
    assert _offset(date(2026, 10, 3), 1, "hours") == _utc(2026, 10, 3, 22, 59, 59)


def test_thirty_minutes_before_due_date() -> None:
    assert _offset(date(2026, 10, 3), 30, "minutes") == _utc(2026, 10, 3, 23, 29, 59)


def test_hour_offset_can_cross_back_into_the_previous_day() -> None:
    assert _offset(date(2026, 10, 3), 25, "hours") == _utc(2026, 10, 2, 22, 59, 59)


def test_minute_offset_boundary_not_due_one_minute_early_due_one_minute_late() -> None:
    remind_at = _offset(date(2026, 10, 3), 30, "minutes")
    assert reminder_due(remind_at, _utc(2026, 10, 3, 23, 28, 59)) is False
    assert reminder_due(remind_at, _utc(2026, 10, 3, 23, 30, 59)) is True


def test_hour_offset_boundary_not_due_just_before_the_instant() -> None:
    remind_at = _offset(date(2026, 10, 3), 2, "hours")
    assert reminder_due(remind_at, _utc(2026, 10, 3, 21, 59, 58)) is False
    assert reminder_due(remind_at, _utc(2026, 10, 3, 21, 59, 59)) is True


def test_offset_with_no_due_date_can_never_fire() -> None:
    assert _offset(None, 2, "days") is None
    assert reminder_due(_offset(None, 2, "days"), _utc(2026, 10, 3)) is False


def test_unknown_unit_falls_back_to_days_rather_than_crashing_the_sweep() -> None:
    assert _offset(date(2026, 9, 21), 2, "fortnights") == _offset(date(2026, 9, 21), 2, "days")


# --- exact mode -------------------------------------------------------------------------------


def test_exact_mode_uses_the_stored_instant_verbatim() -> None:
    at = _utc(2026, 10, 1, 9, 30)
    assert compute_remind_at(mode="exact", due_date=date(2026, 10, 3), offset_value=2, offset_unit="days", reminder_at=at) == at


def test_exact_mode_ignores_the_due_date_entirely() -> None:
    at = _utc(2026, 10, 1, 9, 30)
    assert compute_remind_at(mode="exact", due_date=None, offset_value=2, offset_unit="days", reminder_at=at) == at


def test_exact_mode_not_due_before_and_due_after_its_instant() -> None:
    at = _utc(2026, 10, 1, 9, 30)
    assert reminder_due(at, _utc(2026, 10, 1, 9, 29, 59)) is False
    assert reminder_due(at, _utc(2026, 10, 1, 9, 30)) is True
    assert reminder_due(at, _utc(2026, 10, 1, 9, 34)) is True  # inside one 5-minute sweep


def test_exact_mode_without_an_instant_can_never_fire() -> None:
    assert compute_remind_at(mode="exact", due_date=date(2026, 10, 3), offset_value=2, offset_unit="days", reminder_at=None) is None


def test_naive_exact_instant_is_treated_as_utc_instead_of_raising() -> None:
    naive = datetime(2026, 10, 1, 9, 30)
    assert compute_remind_at(mode="exact", due_date=None, offset_value=0, offset_unit="days", reminder_at=naive) == _utc(2026, 10, 1, 9, 30)


# --- grace window -----------------------------------------------------------------------------


def test_stale_reminder_outside_the_grace_window_does_not_fire() -> None:
    # The first sweep after deploy must not blast a "due soon" notification about a bill whose due
    # date was months ago.
    assert reminder_due(_offset(date(2026, 1, 5), 2, "days"), _utc(2026, 9, 24, 12, 0)) is False


def test_reminder_missed_by_a_few_hours_still_fires() -> None:
    remind_at = _utc(2026, 10, 1, 9, 30)
    assert reminder_due(remind_at, remind_at + timedelta(hours=6)) is True
    assert reminder_due(remind_at, remind_at + REMINDER_GRACE - timedelta(seconds=1)) is True
    assert reminder_due(remind_at, remind_at + REMINDER_GRACE) is False
