import { describe, expect, it } from "vitest";
import { describeReminder, maxExactLocalValue, reminderUpdatePayload } from "./reminder-draft";

// Fixed "now" so these assert the rule, not the day they happen to run.
const NOW = new Date("2026-09-25T12:00:00Z");

function exact(exactLocal: string) {
  return { mode: "exact" as const, value: "2", unit: "days", exactLocal };
}

function offset(value: string, unit = "days") {
  return { mode: "offset" as const, value, unit, exactLocal: "" };
}

describe("reminderUpdatePayload exact mode", () => {
  it("rejects an absurd year and says what is actually wrong", () => {
    // The reported bug: a six-digit year typed straight into <input type="datetime-local"> was
    // accepted, and the only feedback came at submit as "pick a date and time", when one HAD been
    // picked. The message must describe the real problem.
    const result = reminderUpdatePayload(exact("100120-10-05T14:00"), NOW);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("100120");
    expect(result.error).toContain("2 years away");
    expect(result.error).toContain("2028");
    expect(result.error).not.toContain("Pick a date and time for the reminder");
  });

  it("rejects a time that has already passed", () => {
    const result = reminderUpdatePayload(exact("2026-09-24T09:00"), NOW);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("already passed");
  });

  it("still tells you to pick one when nothing is picked at all", () => {
    const result = reminderUpdatePayload(exact(""), NOW);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Pick a date and time");
  });

  it("accepts an instant inside the window", () => {
    const result = reminderUpdatePayload(exact("2026-10-05T14:00"), NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload).toEqual({ reminder_mode: "exact", reminder_at: new Date("2026-10-05T14:00").toISOString() });
  });

  it("publishes a max the browser's own picker can enforce", () => {
    expect(maxExactLocalValue(NOW).startsWith("2028-")).toBe(true);
  });
});

describe("reminderUpdatePayload offset mode", () => {
  it("rejects a value past the column's own ceiling instead of silently clamping it", () => {
    // Clamping was the old behaviour: it saved a different reminder than the one on screen, which is
    // the class of quiet substitution this product exists to not do.
    const result = reminderUpdatePayload(offset("900", "days"), NOW);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("60 days");
  });

  it("rejects an empty value rather than saving zero", () => {
    expect(reminderUpdatePayload(offset(""), NOW).ok).toBe(false);
  });

  it("saves a legitimate hours offset unchanged", () => {
    const result = reminderUpdatePayload(offset("2", "hours"), NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload).toEqual({
      reminder_mode: "offset",
      reminder_offset_value: 2,
      reminder_offset_unit: "hours",
      reminder_at: null,
    });
  });
});

describe("describeReminder", () => {
  const base = { reminder_mode: "offset", reminder_offset_value: 2, reminder_offset_unit: "hours", reminder_at: null };

  it("reads back an offset in words", () => {
    expect(describeReminder({ ...base, due_date: "2026-10-05" })).toBe("2 hours before due");
    expect(describeReminder({ ...base, reminder_offset_value: 1, due_date: "2026-10-05" })).toBe("1 hour before due");
    expect(describeReminder({ ...base, reminder_offset_value: 0, due_date: "2026-10-05" })).toBe("On the due date");
  });

  it("does not describe a reminder that can never fire as if it will", () => {
    // compute_remind_at returns None for an offset with no due date, so the reminder genuinely never
    // arrives. Printing "2 hours before due" here would be a claim about a notification that isn't coming.
    expect(describeReminder({ ...base, due_date: null })).toBe("Needs a due date before it can fire");
  });
});
