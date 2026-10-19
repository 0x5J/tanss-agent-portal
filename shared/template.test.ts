import { describe, expect, it } from "vitest";
import {
  appointmentToTemplate,
  callToTemplate,
  isAppointment,
  openTemplates,
  templateKey,
  type BookingTemplate,
} from "./template.ts";

const at = (iso: string) => Date.parse(iso) / 1000;

describe("appointmentToTemplate", () => {
  it("derives where it takes place from what TANSS knows", () => {
    const teams = appointmentToTemplate(
      { id: 900, date: at("2026-08-25T10:00:00+02:00"), duration: 60, outlookTitle: "Jour fixe", teamsUrl: "https://teams…", companyId: 5 },
      { companies: { "5": { name: "Kranz GmbH" } } },
    );
    expect(teams).toMatchObject({ key: "termin:900", kind: "appointment", startMinute: 600, duration: 60, location: "REMOTE", companyName: "Kranz GmbH", title: "Jour fixe" });

    const onSite = appointmentToTemplate({ id: 901, date: at("2026-08-25T13:00:00+02:00"), duration: 120, outlookTitle: "Vor Ort", outlookLocation: "Musterstr. 1" }, {});
    expect(onSite.location).toBe("CUSTOMER");
    expect(onSite.detail).toBe("Musterstr. 1");

    const plain = appointmentToTemplate({ id: 902, date: at("2026-08-25T08:00:00+02:00"), duration: 30, text: "Interne Runde" }, {});
    expect(plain.location).toBe("OFFICE");
    expect(plain.title).toBe("Interne Runde");
  });

  it("knows an appointment from a support", () => {
    expect(isAppointment("APPOINTMENT_FIX")).toBe(true);
    expect(isAppointment("APPOINTMENT_PRIVATE")).toBe(true);
    expect(isAppointment("SUPPORT")).toBe(false);
    expect(isAppointment(undefined)).toBe(false);
  });
});

describe("callToTemplate", () => {
  const call = (extra: Record<string, unknown> = {}) => ({
    id: 12,
    date: at("2026-08-25T09:05:00+02:00"),
    direction: "IN",
    connectionEstablished: true,
    durationCall: 185,
    fromPhoneNumber: "+4940123",
    fromPhoneNrInfos: { result: { name: "Müller AG", companyId: 7 } },
    ...extra,
  });

  it("rounds up to full minutes and names the counterpart", () => {
    const t = callToTemplate(call())!;
    expect(t).toMatchObject({ key: "anruf:12", kind: "call", duration: 4, companyId: 7, companyName: "Müller AG", location: "REMOTE" });
    expect(t.title).toBe("Telefonat von Müller AG");
  });

  it("uses the called party for an outgoing call", () => {
    const t = callToTemplate(call({ direction: "OUT", toPhoneNumber: "+4930999", toPhoneNrInfos: { result: { name: "Weber KG" } } }))!;
    expect(t.title).toBe("Telefonat an Weber KG");
  });

  it("drops ringing and very short calls", () => {
    expect(callToTemplate(call({ connectionEstablished: false }))).toBeNull();
    expect(callToTemplate(call({ durationCall: 42 }))).toBeNull();
    expect(callToTemplate(call({ durationCall: 60 }))).not.toBeNull();
  });

  it("falls back to the bare number when nobody is known", () => {
    const t = callToTemplate(call({ fromPhoneNrInfos: undefined }))!;
    expect(t.title).toBe("Telefonat von +4940123");
    expect(t.companyId).toBe(0);
  });
});

describe("openTemplates", () => {
  const t = (key: string, iso: string): BookingTemplate => ({
    key, kind: "appointment", date: at(iso), startMinute: 0, duration: 30,
    title: key, detail: "", ticketId: 0, companyId: 0, companyName: "", location: "OFFICE", teamsUrl: "",
  });

  it("hides what was booked already and keeps the day in order", () => {
    const list = [t("termin:2", "2026-08-25T11:00:00+02:00"), t("termin:1", "2026-08-25T09:00:00+02:00"), t("termin:3", "2026-08-24T09:00:00+02:00")];
    const withStart = list.map((x) => ({ ...x, startMinute: new Date(x.date * 1000).getHours() * 60 }));
    const booked = { [templateKey("termin:1", "2026-08-25")]: 4711 };
    const open = openTemplates(withStart, booked, "2026-08-25");
    expect(open.map((x) => x.key)).toEqual(["termin:2"]);
    expect(openTemplates(withStart, {}, "2026-08-25").map((x) => x.key)).toEqual(["termin:1", "termin:2"]);
  });
});
