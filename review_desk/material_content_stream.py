"""Iterate an exported content graph without materializing its entire JSON."""
import json


def members(path, field, envelope=None):
    """Yield one top-level array's members; discard other arrays row by row."""
    decoder=json.JSONDecoder()
    with path.open(encoding='utf-8') as source:
        buffer='';eof=False
        def fill():
            nonlocal buffer,eof
            chunk=source.read(65536);buffer+=chunk;eof=not chunk
        def space():
            nonlocal buffer
            while True:
                buffer=buffer.lstrip()
                if buffer or eof:return
                fill()
        def token(expected):
            nonlocal buffer
            space()
            if not buffer.startswith(expected):raise ValueError('invalid exported content graph')
            buffer=buffer[len(expected):]
        def value():
            nonlocal buffer
            space()
            while True:
                try:
                    result,end=decoder.raw_decode(buffer)
                    if end==len(buffer) and not eof:
                        fill();continue
                    buffer=buffer[end:];return result
                except json.JSONDecodeError:
                    if eof:raise ValueError('truncated exported content graph')
                    fill()
        token('{');seen=set();found=False
        if envelope is None:envelope={}
        while True:
            key=value()
            if not isinstance(key,str) or key in seen:raise ValueError('invalid exported content graph keys')
            seen.add(key);token(':')
            space()
            if buffer.startswith('['):
                envelope[key]=True
                if key==field:found=True
                token('[');space()
                while not buffer.startswith(']'):
                    row=value()
                    if key==field:yield row
                    space()
                    if buffer.startswith(']'):break
                    token(',');space()
                    if buffer.startswith(']'):raise ValueError('invalid exported content separator')
                token(']')
            else:envelope[key]=value()
            space()
            if buffer.startswith('}'):break
            token(',')
        token('}');space()
        if buffer or not found:
            raise ValueError('invalid exported content graph envelope')


def rows(path):
    envelope={}
    for row in members(path,'material_content',envelope):
        if not isinstance(row,dict) or set(row)!= {'id','body'} or not all(isinstance(row[k],str) for k in row):
            raise ValueError('invalid exported content row')
        yield row
    if envelope!={'format':'material-content-v1','material_content':True}:
        raise ValueError('invalid exported content graph envelope')
