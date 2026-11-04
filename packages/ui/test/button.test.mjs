import assert from 'node:assert/strict';
import test from 'node:test';
import { Button } from '../dist/index.js';

test('button retains disabled state, keyboard semantics, and accessible labels', () => {
    const element = Button({ disabled: true, 'aria-label': 'Stop response', size: 'icon' });
    assert.equal(element.type, 'button');
    assert.equal(element.props.disabled, true);
    assert.equal(element.props['aria-label'], 'Stop response');
    assert.match(element.props.className, /focus-visible/);
});
