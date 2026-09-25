from money import format_money


def test_symbol_and_thousands_separator():
    # "2800.00 USD" with no symbol and no separator is what every screen and every reminder used to
    # show; both testers flagged it independently.
    assert format_money(280000, "USD") == "$2,800.00"
    assert format_money(124860, "GBP") == "£1,248.60"


def test_falls_back_to_the_iso_code_for_an_unknown_currency():
    # `currency` on a detected bill comes out of an LLM extraction, so it can be anything. Printing
    # "$" on a bill that isn't in dollars would misstate what's owed.
    assert format_money(45000, "NOK") == "450.00 NOK"
    assert format_money(45000, "") == "450.00"


def test_zero_decimal_currency_has_no_minor_unit():
    assert format_money(120000, "JPY") == "¥1,200"


def test_handles_a_missing_amount_without_raising():
    assert format_money(None, None) == "0.00"
