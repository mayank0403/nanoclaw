#!/usr/bin/env python3
"""
Filtering HTTPS proxy for nanoclaw containers.
Only allows CONNECT tunnels to Anthropic/Claude domains.
All other destinations are rejected with 403.
Allowed connections are forwarded to the upstream OneCLI proxy.
"""
import socket
import threading
import sys
import logging

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
log = logging.getLogger('anthropic-proxy')

LISTEN_HOST = '172.19.0.1'
LISTEN_PORT = 10255
UPSTREAM_HOST = '172.17.0.1'
UPSTREAM_PORT = 10255
ALLOWED_SUFFIXES = ('.anthropic.com', '.claude.ai')

def is_allowed(host: str) -> bool:
    h = host.lower()
    return any(h == s.lstrip('.') or h.endswith(s) for s in ALLOWED_SUFFIXES)

def relay(src, dst):
    try:
        while True:
            data = src.recv(65536)
            if not data:
                break
            dst.sendall(data)
    except:
        pass
    finally:
        try: src.close()
        except: pass
        try: dst.close()
        except: pass

def handle(client):
    try:
        buf = b''
        while b'\r\n\r\n' not in buf:
            chunk = client.recv(4096)
            if not chunk:
                return
            buf += chunk

        first = buf.split(b'\r\n')[0].decode(errors='replace')
        parts = first.split()
        if len(parts) < 2 or parts[0] != 'CONNECT':
            client.sendall(b'HTTP/1.1 405 Method Not Allowed\r\n\r\n')
            return

        target = parts[1]
        host = target.rsplit(':', 1)[0]

        if not is_allowed(host):
            log.warning('BLOCKED %s', target)
            client.sendall(b'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n')
            return

        log.info('ALLOW %s', target)
        upstream = socket.create_connection((UPSTREAM_HOST, UPSTREAM_PORT), timeout=10)
        upstream.sendall(buf)

        t = threading.Thread(target=relay, args=(upstream, client), daemon=True)
        t.start()
        relay(client, upstream)
    except Exception as e:
        log.debug('handle error: %s', e)
        try: client.close()
        except: pass

def main():
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind((LISTEN_HOST, LISTEN_PORT))
    srv.listen(64)
    log.info('Anthropic-only proxy listening on %s:%d', LISTEN_HOST, LISTEN_PORT)
    log.info('Allowed suffixes: %s', ALLOWED_SUFFIXES)
    log.info('Upstream proxy: %s:%d', UPSTREAM_HOST, UPSTREAM_PORT)
    while True:
        client, addr = srv.accept()
        threading.Thread(target=handle, args=(client,), daemon=True).start()

if __name__ == '__main__':
    main()
