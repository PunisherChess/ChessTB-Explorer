/**
 * utils.js — Shared helpers
 */

/**
 * Returns a debounced version of fn that fires after `delay` ms of inactivity.
 * @param {Function} fn
 * @param {number} delay
 */
export function debounce(fn, delay) {
    let timer;
    return function (...args) {
        clearTimeout(timer);
        timer = setTimeout(() => fn.apply(this, args), delay);
    };
}