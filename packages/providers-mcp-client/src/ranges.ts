import { isIP } from 'node:net';

const v4Blocked: [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

const v4ToInt = (ip: string) =>
  ip.split('.').reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;

const inV4 = (ip: string, [base, bits]: [string, number]) => {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (v4ToInt(ip) & mask) === (v4ToInt(base) & mask);
};

const expandV6 = (ip: string): number[] | undefined => {
  let address = ip.toLowerCase().split('%')[0] ?? '';
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  if (tail?.[1]) {
    const n = v4ToInt(tail[1]);
    address = address.replace(tail[1], `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`);
  }
  const [head = '', rest] = address.split('::');
  const left = head ? head.split(':') : [];
  const right = rest === undefined ? [] : rest ? rest.split(':') : [];
  const missing = 8 - left.length - right.length;
  if (rest === undefined && left.length !== 8) return undefined;
  const groups = [...left, ...Array<string>(Math.max(missing, 0)).fill('0'), ...right];
  return groups.length === 8 ? groups.map((g) => parseInt(g || '0', 16)) : undefined;
};

const mappedV4 = (groups: number[]) => {
  const prefixZero = groups.slice(0, 5).every((g) => g === 0);
  const hi = groups[6] ?? 0;
  const lo = groups[7] ?? 0;
  const v4 = `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  if (prefixZero && groups[5] === 0xffff) return v4;
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((g) => g === 0))
    return v4;
  return undefined;
};

export const isPrivateAddress = (ip: string): boolean => {
  const family = isIP(ip);
  if (family === 4) return v4Blocked.some((range) => inV4(ip, range));
  if (family !== 6) return true;
  const groups = expandV6(ip);
  if (!groups) return true;
  const v4 = mappedV4(groups);
  if (v4) return isPrivateAddress(v4);
  const first = groups[0] ?? 0;
  if (groups.every((g) => g === 0)) return true;
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true;
  if ((first & 0xfe00) === 0xfc00) return true;
  if ((first & 0xffc0) === 0xfe80) return true;
  if ((first & 0xff00) === 0xff00) return true;
  return false;
};

export const isLoopbackAddress = (ip: string) =>
  (isIP(ip) === 4 && inV4(ip, ['127.0.0.0', 8])) || ip === '::1';

const v4Reserved: [string, number][] = [
  ['0.0.0.0', 8],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['192.0.0.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

const metadataAddresses = new Set(['100.100.100.200', '168.63.129.16', 'fd00:ec2::254']);

const v6Key = (ip: string) => expandV6(ip)?.join(':');

export const isReservedAddress = (ip: string): boolean => {
  const family = isIP(ip);
  if (metadataAddresses.has(ip.toLowerCase())) return true;
  if (family === 4) return v4Reserved.some((range) => inV4(ip, range));
  if (family !== 6) return true;
  const groups = expandV6(ip);
  if (!groups) return true;
  const v4 = mappedV4(groups);
  if (v4) return isReservedAddress(v4);
  if (v6Key(ip) === v6Key('fd00:ec2::254')) return true;
  const first = groups[0] ?? 0;
  if (groups.slice(0, 7).every((g) => g === 0) && (groups[7] ?? 0) <= 1) return true;
  if ((first & 0xffc0) === 0xfe80) return true;
  return (first & 0xff00) === 0xff00;
};

export interface Cidr {
  family: 4 | 6;
  base: number[];
  bits: number;
}

const groupsOf = (ip: string): { family: 4 | 6; groups: number[] } | undefined => {
  const family = isIP(ip);
  if (family === 4) {
    const n = v4ToInt(ip);
    return { family: 4, groups: [n >>> 16, n & 0xffff] };
  }
  if (family !== 6) return undefined;
  const groups = expandV6(ip);
  if (!groups) return undefined;
  const v4 = mappedV4(groups);
  return v4 ? groupsOf(v4) : { family: 6, groups };
};

export const parseCidr = (text: string): Cidr | undefined => {
  const [address = '', prefix, extra] = text.trim().split('/');
  if (extra !== undefined) return undefined;
  const parsed = groupsOf(address);
  if (!parsed) return undefined;
  const max = parsed.family === 4 ? 32 : 128;
  if (prefix !== undefined && !/^\d{1,3}$/.test(prefix)) return undefined;
  const bits = prefix === undefined ? max : Number(prefix);
  if (bits > max) return undefined;
  return { family: parsed.family, base: parsed.groups, bits };
};

const matches = (cidr: Cidr, groups: number[]) => {
  let left = cidr.bits;
  for (let i = 0; i < groups.length && left > 0; i += 1) {
    const take = Math.min(16, left);
    const mask = (0xffff << (16 - take)) & 0xffff;
    if (((groups[i] ?? 0) & mask) !== ((cidr.base[i] ?? 0) & mask)) return false;
    left -= take;
  }
  return true;
};

export const cidrContains = (cidr: Cidr, ip: string): boolean => {
  const parsed = groupsOf(ip);
  return parsed !== undefined && parsed.family === cidr.family && matches(cidr, parsed.groups);
};

export const cidrOverlaps = (a: Cidr, b: Cidr): boolean => {
  if (a.family !== b.family) return false;
  const shorter = a.bits <= b.bits ? a : b;
  const longer = shorter === a ? b : a;
  return matches(shorter, longer.base);
};

const allowableRanges = [
  '10.0.0.0/8',
  '100.64.0.0/10',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '198.18.0.0/15',
  'fc00::/7',
].map((r) => parseCidr(r) as Cidr);

export const isAllowableRange = (cidr: Cidr): boolean =>
  allowableRanges.some(
    (range) => range.family === cidr.family && range.bits <= cidr.bits && matches(range, cidr.base),
  ) && ![...metadataAddresses].some((ip) => cidrContains(cidr, ip));
