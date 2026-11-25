import { describe, expect, it } from "vitest";
import { toCsv } from "@/lib/admin/csv";

const BOM = "﻿";
const cols = [{ key: "a", label: "A" }];
const cell = (v: unknown) => toCsv([{ a: v }], cols).split("\r\n")[1];

describe("toCsv", () => {
  it("starts with a BOM, then the header, and uses CRLF line endings throughout", () => {
    const out = toCsv([{ a: 1, b: "x" }, { a: 2, b: "y" }], [{ key: "a", label: "數量" }, { key: "b", label: "名稱" }]);
    expect(out.startsWith(BOM)).toBe(true);
    expect(out).toBe(`${BOM}數量,名稱\r\n1,x\r\n2,y\r\n`);
    expect(out.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
  });

  it("quotes values holding a comma, quote or line break, doubling the quotes (RFC 4180)", () => {
    expect(cell('a,"b"')).toBe('"a,""b"""');
    expect(cell("line1\nline2")).toBe('"line1\nline2"');
    expect(cell("x,y")).toBe('"x,y"');
    expect(cell("plain")).toBe("plain");
  });

  it("guards formula injection: a leading = + - @ tab or CR gets a ' in front", () => {
    expect(cell("=1+1")).toBe("'=1+1");
    expect(cell("+SUM(A1)")).toBe("'+SUM(A1)");
    expect(cell("-2+3")).toBe("'-2+3");
    expect(cell("@cmd")).toBe("'@cmd");
    expect(cell("\tTAB")).toBe("'\tTAB");
    expect(cell("\rCR")).toBe('"\'\rCR"'); // guarded, then quoted because it holds a CR
    expect(cell("a=1")).toBe("a=1");
  });

  it("writes JS numbers raw, guards numeric-looking strings, guards header labels, renders null as empty", () => {
    expect(cell(-500)).toBe("-500");
    expect(cell("-500")).toBe("'-500");
    expect(cell("=1+1")).toBe("'=1+1");
    expect(cell(Number.NaN)).toBe("NaN");
    expect(cell(1234)).toBe("1234");
    expect(cell(0)).toBe("0");
    expect(cell(null)).toBe("");
    expect(cell(undefined)).toBe("");
    expect(toCsv([], [{ key: "a", label: "=HYPERLINK(1)" }])).toBe(`${BOM}'=HYPERLINK(1)\r\n`);
  });

  it("guards a value that needs quoting too (guard first, then quote)", () => {
    expect(cell('=A1,"x"')).toBe('"\'=A1,""x"""');
  });

  it("an empty report is just the header row", () => {
    expect(toCsv([], cols)).toBe(`${BOM}A\r\n`);
  });
});
