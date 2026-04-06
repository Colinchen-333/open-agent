import { describe, expect, test } from 'bun:test';
import { InProcessTransport, CallbackTransport, BridgeSession, createBridgeMessage } from '../bridge';

describe('InProcessTransport', () => {
  test('paired transports communicate bidirectionally', () => {
    const [a, b] = InProcessTransport.createPair();
    const received: any[] = [];
    b.onReceive(msg => received.push(msg));
    a.send(createBridgeMessage('user_message', 'hello'));
    expect(received).toHaveLength(1);
    expect(received[0].payload).toBe('hello');
  });

  test('messages flow both ways', () => {
    const [a, b] = InProcessTransport.createPair();
    const fromA: any[] = [];
    const fromB: any[] = [];
    a.onReceive(msg => fromA.push(msg));
    b.onReceive(msg => fromB.push(msg));
    a.send(createBridgeMessage('user_message', 'to-b'));
    b.send(createBridgeMessage('assistant_message', 'to-a'));
    expect(fromB).toHaveLength(1);
    expect(fromA).toHaveLength(1);
  });

  test('close stops delivery', () => {
    const [a, b] = InProcessTransport.createPair();
    const received: any[] = [];
    b.onReceive(msg => received.push(msg));
    a.close();
    a.send(createBridgeMessage('user_message', 'after-close'));
    expect(received).toHaveLength(0);
  });
});

describe('CallbackTransport', () => {
  test('send delegates to callback', () => {
    const sent: any[] = [];
    const transport = new CallbackTransport(msg => { sent.push(msg); });
    transport.send(createBridgeMessage('status', 'ok'));
    expect(sent).toHaveLength(1);
  });

  test('inject triggers receive handlers', () => {
    const transport = new CallbackTransport(() => {});
    const received: any[] = [];
    transport.onReceive(msg => received.push(msg));
    transport.inject(createBridgeMessage('error', 'test error'));
    expect(received).toHaveLength(1);
    expect(received[0].type).toBe('error');
  });
});

describe('BridgeSession', () => {
  test('on/send message lifecycle', () => {
    const [runtime, ui] = InProcessTransport.createPair();
    const session = new BridgeSession(runtime, 'test-session');
    const uiReceived: any[] = [];
    ui.onReceive(msg => uiReceived.push(msg));

    session.send('assistant_message', 'Hello!');
    expect(uiReceived).toHaveLength(1);
    expect(uiReceived[0].type).toBe('assistant_message');
    expect(uiReceived[0].sessionId).toBe('test-session');

    session.close();
  });

  test('on registers typed handler', () => {
    const [runtime, ui] = InProcessTransport.createPair();
    const session = new BridgeSession(runtime, 's1');
    const errors: any[] = [];
    session.on('error', payload => errors.push(payload));

    ui.send(createBridgeMessage('error', 'something broke', 's1'));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBe('something broke');

    session.close();
  });

  test('unsubscribe removes handler', () => {
    const [runtime, ui] = InProcessTransport.createPair();
    const session = new BridgeSession(runtime, 's1');
    const msgs: any[] = [];
    const unsub = session.on('status', p => msgs.push(p));

    ui.send(createBridgeMessage('status', 'first'));
    unsub();
    ui.send(createBridgeMessage('status', 'second'));

    expect(msgs).toHaveLength(1);
    session.close();
  });

  test('getSessionId returns ID', () => {
    const [runtime] = InProcessTransport.createPair();
    const session = new BridgeSession(runtime, 'my-session');
    expect(session.getSessionId()).toBe('my-session');
    session.close();
  });
});

describe('createBridgeMessage', () => {
  test('generates unique IDs', () => {
    const a = createBridgeMessage('status', null);
    const b = createBridgeMessage('status', null);
    expect(a.id).not.toBe(b.id);
  });

  test('includes timestamp', () => {
    const msg = createBridgeMessage('heartbeat', {});
    expect(msg.timestamp).toBeDefined();
  });
});
