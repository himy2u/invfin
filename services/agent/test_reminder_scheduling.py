from datetime import date

from reminder_scheduling import reminder_due_today, subtract_business_days


def test_subtract_business_days_within_week() -> None:
    # Wednesday minus 2 business days = Monday (no weekend in between)
    assert subtract_business_days(date(2026, 9, 23), 2) == date(2026, 9, 21)


def test_subtract_business_days_crosses_weekend() -> None:
    # Monday minus 2 business days should land on the preceding Thursday, skipping Sat/Sun
    assert subtract_business_days(date(2026, 9, 21), 2) == date(2026, 9, 17)


def test_subtract_business_days_zero_returns_due_date() -> None:
    assert subtract_business_days(date(2026, 9, 21), 0) == date(2026, 9, 21)


def test_reminder_due_today_true_on_matching_day() -> None:
    due = date(2026, 9, 21)  # Monday
    today = date(2026, 9, 17)  # Thursday, 2 business days before
    assert reminder_due_today(due, 2, today) is True


def test_reminder_due_today_false_on_weekend() -> None:
    due = date(2026, 9, 21)  # Monday
    saturday = date(2026, 9, 19)
    assert reminder_due_today(due, 2, saturday) is False


def test_reminder_due_today_false_before_window() -> None:
    due = date(2026, 9, 30)
    today = date(2026, 9, 21)
    assert reminder_due_today(due, 2, today) is False
