const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export const crc32 = (data: Uint8Array) => {
  let crc = 0xffffffff;
  for (const byte of data) crc = (crcTable[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

export const storeZip = (entries: ZipEntry[]): Uint8Array => {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const crc = crc32(entry.data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true);
    local.setUint16(8, 0, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, entry.data.byteLength, true);
    local.setUint32(22, entry.data.byteLength, true);
    local.setUint16(26, name.byteLength, true);
    const localBytes = new Uint8Array([...new Uint8Array(local.buffer), ...name, ...entry.data]);
    locals.push(localBytes);
    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, 20, true);
    central.setUint16(6, 20, true);
    central.setUint16(8, 0x0800, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, entry.data.byteLength, true);
    central.setUint32(24, entry.data.byteLength, true);
    central.setUint16(28, name.byteLength, true);
    central.setUint32(42, offset, true);
    centrals.push(new Uint8Array([...new Uint8Array(central.buffer), ...name]));
    offset += localBytes.byteLength;
  }
  const centralSize = centrals.reduce((a, c) => a + c.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  const out = new Uint8Array(offset + centralSize + 22);
  let at = 0;
  for (const part of [...locals, ...centrals, new Uint8Array(end.buffer)]) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
};
