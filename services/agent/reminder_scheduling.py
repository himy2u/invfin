from datetime import date, timedelta

# "Business days before" rather than calendar days — a due date on Monday with a 2-day reminder
# should fire the preceding Thursday, not Saturday (when the user is unlikely to check the app and
# can't act on it anyway — banks/billers aren't processing payments over the weekend either).


_MAX_BUSINESS_DAYS = 60  # matches the DB CHECK constraint on reminder_days_before(_default) —
# defense in depth: this loops one day at a time, so an unbounded value would spin a worker thread
# forever inside the reminder cron's asyncio.to_thread call, which asyncio.wait_for's timeout
# cannot actually cancel.


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


def reminder_due_today(due_date: date, reminder_days_before: int, today: date) -> bool:
    return subtract_business_days(due_date, reminder_days_before) == today
