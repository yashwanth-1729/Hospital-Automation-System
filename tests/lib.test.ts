import { describe, expect, it } from "vitest";
import { CORRELATION_ID_PATTERN, newCorrelationId, newId } from "@/lib/ids";
import { backoffSeconds } from "@/lib/jobs";
import { maskPhone, normalizeIndianPhone } from "@/lib/phone";
import { addDays, formatSlot, istAt, istDateString, istDayRange, isValidDateString } from "@/lib/time";
import { renderTemplate, TemplateError } from "@/server/messaging/templates";

describe("phone normalization", () => {
  it.each([
    ["9876543210", "+919876543210"],
    ["98765 43210", "+919876543210"],
    ["+91 98765-43210", "+919876543210"],
    ["919876543210", "+919876543210"],
    ["09876543210", "+919876543210"],
  ])("%s -> %s", (input, expected) => {
    expect(normalizeIndianPhone(input)).toBe(expected);
  });

  it.each(["12345", "5876543210", "abcdefghij", "98765432101234"])("rejects %s", (input) => {
    expect(normalizeIndianPhone(input)).toBeNull();
  });

  it("masks phones", () => {
    expect(maskPhone("+919876543210")).toBe("+91 ••••• •3210");
  });
});

describe("time (IST)", () => {
  it("computes the IST date across the UTC boundary", () => {
    // 20:00 UTC is 01:30 next day in IST.
    expect(istDateString(new Date("2026-09-20T20:00:00Z"))).toBe("2026-09-21");
  });

  it("builds day ranges and wall-clock instants", () => {
    const [s, e] = istDayRange("2026-09-21");
    expect(s.toISOString()).toBe("2026-09-20T18:30:00.000Z");
    expect(e.getTime() - s.getTime()).toBe(86400000);
    expect(istAt("2026-09-21", 10, 30).toISOString()).toBe("2026-09-21T05:00:00.000Z");
  });

  it("adds days and validates dates", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(isValidDateString("2026-02-30")).toBe(false);
    expect(isValidDateString("2026-09-21")).toBe(true);
  });

  it("formats slots for patients in IST", () => {
    expect(formatSlot(istAt("2026-09-21", 10, 30))).toBe("Mon, 21 Sep 2026, 10:30 AM");
  });
});

describe("ids", () => {
  it("creates blueprint-format correlation ids", () => {
    const id = newCorrelationId(new Date("2026-09-05T06:00:00Z"));
    expect(id).toMatch(CORRELATION_ID_PATTERN);
    expect(id.startsWith("HOSP-20260905-")).toBe(true);
  });

  it("creates unique prefixed ids", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newId("LEAD")));
    expect(ids.size).toBe(1000);
  });
});

describe("templates", () => {
  it("renders with all variables", () => {
    const r = renderTemplate("ENQUIRY_ACK_01", { patient_name: "Rahul", hospital_name: "DemoCare" });
    expect(r.body).toContain("Rahul");
    expect(r.params).toEqual(["Rahul", "DemoCare"]);
  });

  it("refuses to send with a missing variable", () => {
    expect(() => renderTemplate("ENQUIRY_ACK_01", { patient_name: "Rahul", hospital_name: " " })).toThrow(TemplateError);
  });
});

describe("job backoff", () => {
  it("grows exponentially and caps", () => {
    expect([1, 2, 3, 4].map(backoffSeconds)).toEqual([30, 60, 120, 240]);
    expect(backoffSeconds(20)).toBe(1800);
  });
});

describe("staff timestamps", () => {
  it("formats compactly in IST", async () => {
    const { formatDateTime } = await import("@/lib/time");
    expect(formatDateTime(istAt("2026-09-20", 0, 45))).toBe("20 Sep, 12:45 AM");
    expect(formatDateTime(null)).toBe("—");
  });
});
