got = [int.from_bytes([1, 2], 'big'), int.from_bytes([1, 2], 'little'), int.from_bytes([255], 'big', signed=True), int.from_bytes([], 'big'), int.from_bytes([0, 0, 1], byteorder='little'), int.from_bytes([128, 0], 'big', signed=True), bool.from_bytes([1], 'big'), int.from_bytes(range(1, 4), 'big')]
big = int.from_bytes([254] * 1000, 'little')
got.append(big % 1000003)
if got != [258, 513, -1, 0, 65536, -32768, True, 66051, 514850]:
    raise AssertionError(got)
