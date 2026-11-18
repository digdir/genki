"""Generate tiny uncompressed Parquet fixtures with Thrift compact encoding.

No external dependencies. Each row is its own row group; all fields are required
UTF-8 byte arrays encoded PLAIN. Run from any directory with Python 3.
"""
from pathlib import Path
from struct import pack


def varint(n):
    out = bytearray()
    while n > 127:
        out.append((n & 127) | 128)
        n >>= 7
    out.append(n)
    return bytes(out)


def integer(n):
    return varint(n * 2 if n >= 0 else -n * 2 - 1)


def binary(s):
    b = s.encode()
    return varint(len(b)) + b


def listing(t, values):
    return bytes([(len(values) << 4) | t]) + b''.join(values)


def struct(fields):
    previous = 0
    result = b''
    for field, kind, value in fields:
        delta = field - previous
        result += (bytes([(delta << 4) | kind]) if 0 < delta < 16 else bytes([kind]) + integer(field)) + value
        previous = field
    return result + b'\x00'


def parquet(rows):
    names = ['id', 'title', 'body']
    root = struct([(4, 8, binary('schema')), (5, 5, integer(3))])
    schema = [root] + [struct([(1, 5, integer(6)), (3, 5, integer(0)), (4, 8, binary(n)), (6, 5, integer(0))]) for n in names]
    data = b'PAR1'
    groups = []
    for row in rows:
        chunks = []
        total = 0
        for name, value in zip(names, row):
            encoded = value.encode()
            payload = pack('<I', len(encoded)) + encoded
            page = struct([(1, 5, integer(0)), (2, 5, integer(len(payload))), (3, 5, integer(len(payload))), (5, 12, struct([(1, 5, integer(1)), (2, 5, integer(0)), (3, 5, integer(3)), (4, 5, integer(3))]))]) + payload
            offset = len(data)
            data += page
            total += len(page)
            metadata = struct([(1, 5, integer(6)), (2, 9, listing(5, [integer(0), integer(3)])), (3, 9, listing(8, [binary(name)])), (4, 5, integer(0)), (5, 6, integer(1)), (6, 6, integer(len(page))), (7, 6, integer(len(page))), (9, 6, integer(offset))])
            chunks.append(struct([(2, 6, integer(offset)), (3, 12, metadata)]))
        groups.append(struct([(1, 9, listing(12, chunks)), (2, 6, integer(total)), (3, 6, integer(1))]))
    footer = struct([(1, 5, integer(1)), (2, 9, listing(12, schema)), (3, 6, integer(len(rows))), (4, 9, listing(12, groups))])
    return data + footer + pack('<I', len(footer)) + b'PAR1'


root = Path(__file__).parent
rows = [(x, f'Title {x}', f'Body of document {x}.') for x in 'abcd']
for name, selected in [('shard-a', rows[:2]), ('shard-b', rows[2:]), ('reshard-a', [rows[3], rows[1]]), ('reshard-b', [rows[2], rows[0]])]:
    (root / f'{name}.parquet').write_bytes(parquet(selected))
# >512 KiB per group makes range and lazy decoding behavior observable.
(root / 'row-groups.parquet').write_bytes(parquet([(x, x, x * 600_000) for x in 'ab']))
