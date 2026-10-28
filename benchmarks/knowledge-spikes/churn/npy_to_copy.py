# Writes a little-endian float32 .npy matrix as COPY text rows: n<TAB>[v1,...]
import struct, sys, ast
data = open(sys.argv[1], 'rb').read()
hlen = struct.unpack('<H', data[8:10])[0]
header = ast.literal_eval(data[10:10 + hlen].decode('latin1'))
rows, dims = header['shape']
assert header['descr'] == '<f4' and not header['fortran_order']
body = data[10 + hlen:]
for r in range(rows):
    vals = struct.unpack_from('<%df' % dims, body, r * dims * 4)
    sys.stdout.write('%d\t[%s]\n' % (r + 1, ','.join('%.7g' % v for v in vals)))
