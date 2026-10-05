import assert from 'node:assert/strict';
import { diffUsbDevices } from '../packages/gateway/src/usb-monitor.ts';

assert.deepEqual(diffUsbDevices(undefined, ['1-1']), { added: [], removed: [] });
assert.deepEqual(diffUsbDevices(['1-1', '2-1.3'], ['1-1', '3-2']), { added: ['3-2'], removed: ['2-1.3'] });
assert.deepEqual(diffUsbDevices([], ['1-1', '2-2']), { added: ['1-1', '2-2'], removed: [] });
assert.deepEqual(diffUsbDevices(['1-1'], []), { added: [], removed: ['1-1'] });
console.log('[usb-monitor] PASS');
