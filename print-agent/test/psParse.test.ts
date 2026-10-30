import { describe, expect, it } from 'vitest';
import {
  asArray,
  decodeJobFlags,
  decodePrinterStatusFlags,
  parseJsonLoose,
  parsePrinters,
  parsePrintedEvents,
  parsePsDate,
  parseSpoolerJobs,
  PsParseError,
} from '../src/printer/psParse.js';

// Realistic output of WINDOWS_LIST_PRINTERS_SCRIPT on a shop PC (two printers + virtual ones).
const PRINTERS_ARRAY = `\uFEFF[
 {"Name":"HP LaserJet M1136 MFP","Default":true,"WorkOffline":false,"PrinterStatus":3,"DetectedErrorState":2,"ExtendedPrinterStatus":2,"MsftPrinterStatus":0,
  "Capabilities":[4,5,3],"CapabilityDescriptions":["Copies","Collate","Duplex"],
  "PrinterPaperNames":["Letter","Legal","Executive","A4","A5","B5 (JIS)","Envelope #10","16K 197x273 mm","Postcard (JIS)"],
  "PaperSizesSupported":[7,8,22,23],"NetSupportsColor":false,"NetCanDuplex":true,
  "NetPaperNames":["Letter","Legal","Executive","A4","A5"],"DriverName":"HP LaserJet Professional M1136 MFP","PortName":"USB001"},
 {"Name":"EPSON L3150 Series","Default":false,"WorkOffline":true,"PrinterStatus":7,"DetectedErrorState":9,"ExtendedPrinterStatus":7,"MsftPrinterStatus":128,
  "Capabilities":[4,2],"CapabilityDescriptions":["Copies","Color"],
  "PrinterPaperNames":["A4 210 x 297 mm","A3 297 x 420 mm","Legal 8 1/2 x 14 in","Letter 8 1/2 x 11 in"],
  "PaperSizesSupported":[22,21,8,7],"NetSupportsColor":true,"NetCanDuplex":false,
  "NetPaperNames":["A4 210 x 297 mm","Legal 8 1/2 x 14 in"],"DriverName":"EPSON L3150 Series","PortName":"WSD-1234"},
 {"Name":"Canon iR2520","Default":false,"WorkOffline":false,"PrinterStatus":3,"DetectedErrorState":4,"ExtendedPrinterStatus":2,"MsftPrinterStatus":16,
  "Capabilities":[4,3],"CapabilityDescriptions":["Copies","Duplex"],"PrinterPaperNames":["A3","A4","A4 Rotated"],"PaperSizesSupported":[21,22],
  "NetSupportsColor":null,"NetCanDuplex":null,"NetPaperNames":[],"DriverName":"Canon","PortName":"IP_192.168.1.20"}
]`;

// Windows PowerShell 5.1: one printer → bare object; one-element arrays collapsed to scalars.
const PRINTER_SINGLE = `{"Name":"Microsoft Print to PDF","Default":false,"WorkOffline":false,"PrinterStatus":3,"DetectedErrorState":0,"MsftPrinterStatus":0,
 "Capabilities":4,"CapabilityDescriptions":"Copies","PrinterPaperNames":"A4","PaperSizesSupported":22,"NetSupportsColor":true,"NetCanDuplex":false,"NetPaperNames":"A4"}`;

// 5.1 quirk: array wrapped as { value, Count }
const PRINTER_WRAPPED = `{"value":[{"Name":"P1","Default":false,"WorkOffline":false,"PrinterStatus":4,"DetectedErrorState":2,"MsftPrinterStatus":1024,
 "Capabilities":{"value":[2,3],"Count":2},"PrinterPaperNames":["A4"],"NetSupportsColor":null,"NetCanDuplex":null}],"Count":1}`;

describe('PowerShell JSON quirks', () => {
  it('empty / null / single / array / wrapped', () => {
    expect(asArray(parseJsonLoose(''))).toEqual([]);
    expect(asArray(parseJsonLoose('null'))).toEqual([]);
    expect(asArray(parseJsonLoose('  \r\n'))).toEqual([]);
    expect(asArray(parseJsonLoose('{"a":1}'))).toEqual([{ a: 1 }]);
    expect(asArray(parseJsonLoose('[{"a":1},{"a":2}]'))).toHaveLength(2);
    expect(asArray(parseJsonLoose('{"value":[1,2],"Count":2}'))).toEqual([1, 2]);
    expect(() => parseJsonLoose('Get-Printer : The spooler service is not reachable')).toThrow(PsParseError);
  });
  it('dates', () => {
    expect(parsePsDate('/Date(1730000000000)/')).toBe(1730000000000);
    expect(parsePsDate('/Date(1730000000000+0530)/')).toBe(1730000000000);
    expect(parsePsDate('2026-10-30T05:30:00.000Z')).toBe(Date.parse('2026-10-30T05:30:00.000Z'));
    expect(parsePsDate(1730000000000)).toBe(1730000000000);
    expect(parsePsDate(null)).toBeNull();
  });
});

describe('printer parsing + status mapping', () => {
  it('parses a realistic multi-printer array', () => {
    const ps = parsePrinters(PRINTERS_ARRAY);
    expect(ps).toHaveLength(3);
    const hp = ps[0]!;
    expect(hp).toMatchObject({ name: 'HP LaserJet M1136 MFP', isDefault: true, status: 'Normal', supportsColor: false, supportsDuplex: true });
    expect(hp.paperSizes).toEqual(['A4', 'Legal', 'Letter']);
    const ep = ps[1]!;
    expect(ep).toMatchObject({ status: 'Offline', supportsColor: true, supportsDuplex: false });
    expect(ep.paperSizes).toEqual(['A4', 'A3', 'Legal', 'Letter']);
    expect(ep.statusDetail).toMatch(/WorkOffline=true/);
    const canon = ps[2]!;
    // .NET info missing → fall back to Win32 capabilities
    expect(canon).toMatchObject({ status: 'PaperOut', supportsColor: false, supportsDuplex: true });
    expect(canon.paperSizes).toEqual(['A4', 'A3']);
  });
  it('single object with collapsed scalar arrays', () => {
    const ps = parsePrinters(PRINTER_SINGLE);
    expect(ps).toHaveLength(1);
    expect(ps[0]).toMatchObject({ name: 'Microsoft Print to PDF', status: 'Normal', supportsColor: true, supportsDuplex: false, paperSizes: ['A4'] });
  });
  it('wrapped arrays', () => {
    const ps = parsePrinters(PRINTER_WRAPPED);
    expect(ps[0]).toMatchObject({ name: 'P1', status: 'Printing', supportsColor: true, supportsDuplex: true });
  });
  it('status priority and flag decoding', () => {
    const mk = (o: Record<string, unknown>): string => parsePrinters(JSON.stringify({ Name: 'x', ...o }))[0]!.status;
    expect(mk({ MsftPrinterStatus: 0, PrinterStatus: 3, DetectedErrorState: 2 })).toBe('Normal');
    expect(mk({ MsftPrinterStatus: 128 })).toBe('Offline');
    expect(mk({ MsftPrinterStatus: 16 })).toBe('PaperOut');
    expect(mk({ MsftPrinterStatus: 16 | 128 })).toBe('Offline');
    expect(mk({ MsftPrinterStatus: 8 })).toBe('PaperJam');
    expect(mk({ MsftPrinterStatus: 1 })).toBe('Paused');
    expect(mk({ MsftPrinterStatus: 2 })).toBe('Error');
    expect(mk({ MsftPrinterStatus: 0x400000 })).toBe('DoorOpen');
    expect(mk({ MsftPrinterStatus: 0x40000 })).toBe('TonerOut');
    expect(mk({ MsftPrinterStatus: 0x100000 })).toBe('UserIntervention');
    expect(mk({ MsftPrinterStatus: 0x20000 })).toBe('Normal'); // toner LOW is not blocking
    expect(mk({ DetectedErrorState: 4 })).toBe('PaperOut');
    expect(mk({ DetectedErrorState: 3 })).toBe('Normal'); // low paper
    expect(mk({ DetectedErrorState: 8 })).toBe('PaperJam');
    expect(mk({ DetectedErrorState: 10 })).toBe('Error');
    expect(mk({ PrinterStatus: 7 })).toBe('Offline');
    expect(mk({ WorkOffline: 'True' })).toBe('Offline');
    expect(mk({ MsftPrinterStatus: 'Offline, PaperOut' })).toBe('Offline');
    expect(mk({ MsftPrinterStatus: 'Normal' })).toBe('Normal');
    expect(decodePrinterStatusFlags(0x400 | 0x10)).toEqual(['PaperOut', 'Printing']);
  });
});

describe('spooler job parsing', () => {
  const JOBS = `[
   {"JobId":12,"Name":"HP LaserJet M1136 MFP, 12","PrinterName":"HP LaserJet M1136 MFP","Document":"C:\\\\ProgramData\\\\MansaPrintAgent\\\\tmp\\\\a-1\\\\MP_MP-20261030-0042_aaaa.pdf","StatusMask":16,"JobStatus":"Printing","Status":"OK","TotalPages":4,"PagesPrinted":1,"Submitted":1730000000000},
   {"JobId":13,"Name":"HP LaserJet M1136 MFP, 13","Document":"MP_MP-20261030-0043_bbbb.pdf","StatusMask":66,"JobStatus":"Error | Paperout","Status":"Degraded","TotalPages":2,"PagesPrinted":0,"Submitted":"/Date(1730000001000)/"}
  ]`;
  it('parses Win32_PrintJob records', () => {
    const js = parseSpoolerJobs(JOBS, 'HP LaserJet M1136 MFP');
    expect(js).toHaveLength(2);
    expect(js[0]).toMatchObject({ id: 12, totalPages: 4, pagesPrinted: 1, submittedAt: 1730000000000, flags: ['Printing'] });
    expect(js[0]!.document).toContain('MP_MP-20261030-0042_aaaa.pdf');
    expect(js[1]!.flags.sort()).toEqual(['Error', 'PaperOut']);
    expect(js[1]!.printerName).toBe('HP LaserJet M1136 MFP');
    expect(js[1]!.submittedAt).toBe(1730000001000);
  });
  it('single job object; printer name containing commas; id from Name', () => {
    const js = parseSpoolerJobs('{"Name":"HP, Office, 7","Document":"x.pdf","StatusMask":8}', 'HP, Office');
    expect(js).toEqual([expect.objectContaining({ id: 7, printerName: 'HP, Office', flags: ['Spooling'] })]);
  });
  it('empty queue', () => {
    expect(parseSpoolerJobs('', 'p')).toEqual([]);
    expect(parseSpoolerJobs('[]', 'p')).toEqual([]);
  });
  it('flag decoding from bitmask, Get-PrintJob strings and numeric JobStatus', () => {
    expect(decodeJobFlags(0x80 | 0x2000, undefined).sort()).toEqual(['Printed', 'Retained']);
    expect(decodeJobFlags(undefined, 'Printing, Retained').sort()).toEqual(['Printing', 'Retained']);
    expect(decodeJobFlags(undefined, 'Error | Offline | User_Intervention_Req').sort()).toEqual(['Error', 'Offline', 'UserIntervention']);
    expect(decodeJobFlags(undefined, 1040).sort()).toEqual(['Printing', 'UserIntervention']);
    expect(decodeJobFlags(0, 'Normal')).toEqual([]);
    expect(decodeJobFlags(0x4 | 0x100, '')).toEqual(['Deleting', 'Deleted']);
  });
});

describe('Event 307 parsing', () => {
  it('parses events; hidden document names kept as-is', () => {
    const ev = parsePrintedEvents(
      '[{"JobId":12,"Document":"Print Document","Printer":"HP LaserJet M1136 MFP","Pages":4,"TimeCreated":1730000005000},{"JobId":13,"Document":"MP_x_bbbb.pdf","Printer":"HP","Pages":null,"TimeCreated":"/Date(1730000009000)/"}]',
    );
    expect(ev).toEqual([
      { spoolerJobId: 12, document: 'Print Document', printerName: 'HP LaserJet M1136 MFP', pages: 4, timeCreated: 1730000005000 },
      { spoolerJobId: 13, document: 'MP_x_bbbb.pdf', printerName: 'HP', pages: null, timeCreated: 1730000009000 },
    ]);
    expect(parsePrintedEvents('{"JobId":1,"Document":"d","Printer":"p","Pages":1,"TimeCreated":5}')).toHaveLength(1);
  });
});
