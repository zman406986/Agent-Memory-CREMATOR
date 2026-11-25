// CREMATOR's composer dock counter — the shipped browser artifact.
//
// One classic script, one lazily registered Cordis plugin. It draws a small
// flame immediately right of the composer's context ring and opens a one-row
// popover ("Cremated", a human byte size, exact bytes in the title).
//
// The value comes from one same-origin GET the host plugin registers:
//   /cremator/cremated?session=<session id>
// It polls every 2 s, only while the page is visible. Every failure is silent:
// the icon stays, the value renders "-", and nothing throws into the composer.
(function () {
  'use strict';

  try {
    if (typeof console !== 'undefined' && console && typeof console.info === 'function') {
      console.info('[cremator-dsh] module loaded');
    }
  } catch (error) { /* diagnostics only */ }

  var warned = false;
  function warnOnce(error) {
    if (warned) return;
    warned = true;
    try {
      var text = error && error.message ? error.message : String(error);
      if (typeof console !== 'undefined' && console && typeof console.warn === 'function') {
        console.warn('[cremator-dsh] composer counter unavailable: ' + text);
      }
    } catch (ignored) { /* a log must never break the dock */ }
  }

  function readPayload(payload) {
    try {
      if (!payload || typeof payload !== 'object') return null;
      var bytes = payload.removedBytes;
      if (typeof bytes !== 'number' || !isFinite(bytes) || bytes < 0) return null;
      var display = typeof payload.display === 'string' && payload.display.length > 0
        ? payload.display : String(bytes) + ' B';
      return { bytes: bytes, display: display };
    } catch (error) {
      return null;
    }
  }

  function factory(require) {
    var React = null;
    try {
      React = require('react');
    } catch (error) {
      warnOnce(error);
      return { inject: [], apply: function () {} };
    }
    if (!React || typeof React.createElement !== 'function') {
      warnOnce('react module has no createElement');
      return { inject: [], apply: function () {} };
    }
    var h = React.createElement;
    var ReactDOM = null;
    try { ReactDOM = require('react-dom'); } catch (ignored) { ReactDOM = null; }

    var INTERVAL_MS = 2000;
    var ROUTE = '/cremator/cremated?session=';
    var POPOVER_WIDTH = 184;

    function useCremated(sessionId) {
      var state = React.useState(null);
      var data = state[0];
      var setData = state[1];
      React.useEffect(function () {
        try {
          if (typeof sessionId !== 'string' || sessionId.length === 0) {
            setData(null);
            return undefined;
          }
        } catch (error) {
          return undefined;
        }
        setData(null);
        var stopped = false;
        var timer = 0;
        var controller = null;
        function load() {
          try {
            if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
            if (typeof fetch !== 'function') return;
            if (controller) { try { controller.abort(); } catch (ignored) {} }
            controller = typeof AbortController === 'function' ? new AbortController() : null;
            var init = { headers: { accept: 'application/json' }, cache: 'no-store' };
            if (controller) init.signal = controller.signal;
            fetch(ROUTE + encodeURIComponent(sessionId), init)
              .then(function (response) {
                return response && response.ok ? response.json() : null;
              })
              .then(function (payload) {
                if (!stopped) setData(readPayload(payload));
              })
              .catch(function () {
                if (!stopped) setData(null);
              });
          } catch (error) {
            if (!stopped) setData(null);
          }
        }
        load();
        try { timer = window.setInterval(load, INTERVAL_MS); } catch (ignored) {}
        try {
          if (typeof document !== 'undefined') document.addEventListener('visibilitychange', load);
        } catch (ignored) {}
        return function () {
          stopped = true;
          try { clearInterval(timer); } catch (ignored) {}
          try {
            if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', load);
          } catch (ignored) {}
          try { if (controller) controller.abort(); } catch (ignored) {}
        };
      }, [sessionId]);
      return data;
    }

    function placeAbove(button, setPosition) {
      try {
        if (!button || typeof window === 'undefined') return;
        var rect = button.getBoundingClientRect();
        var width = typeof window.innerWidth === 'number' ? window.innerWidth : 1024;
        var height = typeof window.innerHeight === 'number' ? window.innerHeight : 768;
        var maxLeft = Math.max(8, width - POPOVER_WIDTH - 8);
        var left = Math.max(8, Math.min(rect.right - POPOVER_WIDTH, maxLeft));
        var bottom = Math.max(8, height - rect.top + 6);
        setPosition({ left: left, bottom: bottom });
      } catch (error) {
        setPosition(null);
      }
    }

    function CrematedCounter(props) {
      var sessionId = '';
      try {
        sessionId = props && typeof props.sessionId === 'string' ? props.sessionId : '';
      } catch (ignored) {
        sessionId = '';
      }
      var data = useCremated(sessionId);
      var openState = React.useState(false);
      var open = openState[0];
      var setOpen = openState[1];
      var positionState = React.useState(null);
      var position = positionState[0];
      var setPosition = positionState[1];
      var hoverState = React.useState(false);
      var hovered = hoverState[0];
      var setHovered = hoverState[1];
      var focusState = React.useState(false);
      var focused = focusState[0];
      var setFocused = focusState[1];
      var buttonRef = React.useRef(null);
      var popoverRef = React.useRef(null);

      React.useEffect(function () {
        try {
          if (!open) return undefined;
          function refresh() { placeAbove(buttonRef.current, setPosition); }
          refresh();
          function onPointerDown(event) {
            try {
              var target = event && event.target;
              if (buttonRef.current && buttonRef.current.contains(target)) return;
              if (popoverRef.current && popoverRef.current.contains(target)) return;
              setOpen(false);
            } catch (error) {
              setOpen(false);
            }
          }
          function onKeyDown(event) {
            if (event && event.key === 'Escape') setOpen(false);
          }
          window.addEventListener('resize', refresh);
          window.addEventListener('scroll', refresh, true);
          document.addEventListener('pointerdown', onPointerDown, true);
          document.addEventListener('keydown', onKeyDown, true);
          return function () {
            try { window.removeEventListener('resize', refresh); } catch (ignored) {}
            try { window.removeEventListener('scroll', refresh, true); } catch (ignored) {}
            try { document.removeEventListener('pointerdown', onPointerDown, true); } catch (ignored) {}
            try { document.removeEventListener('keydown', onKeyDown, true); } catch (ignored) {}
          };
        } catch (error) {
          return undefined;
        }
      }, [open]);

      function onClick(event) {
        try {
          if (event) {
            event.preventDefault();
            event.stopPropagation();
          }
          setOpen(!open);
        } catch (error) {
          try { setOpen(false); } catch (ignored) {}
        }
      }

      try {
        var label = data ? data.display : '-';
        var exact = data ? String(data.bytes) + ' bytes' : 'No CREMATOR removals recorded for this session';
        var buttonStyle = {
          width: '20px',
          height: '20px',
          padding: '0',
          margin: '0',
          border: '0',
          borderRadius: '5px',
          background: hovered ? 'var(--dsw-alias-interactive-bg-hover, transparent)' : 'transparent',
          color: 'var(--dsw-alias-label-tertiary, currentColor)',
          cursor: 'pointer',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flex: '0 0 auto',
          order: 2,
          lineHeight: '1',
          outline: focused ? '2px solid var(--dsw-alias-border-l4, currentColor)' : 'none',
          outlineOffset: '1px'
        };
        var row = h('div', {
          style: {
            display: 'flex',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            gap: '16px',
            whiteSpace: 'nowrap'
          }
        }, h('span', {
          style: { color: 'var(--dsw-alias-label-tertiary, GrayText)' }
        }, 'Cremated'), h('span', {
          title: exact,
          style: { fontVariantNumeric: 'tabular-nums', fontWeight: 600 }
        }, label));
        var popover = h('div', {
          ref: popoverRef,
          role: 'dialog',
          'aria-label': 'CREMATOR bytes cremated',
          style: {
            position: 'fixed',
            left: (position ? position.left : 0) + 'px',
            bottom: (position ? position.bottom : 0) + 'px',
            zIndex: '2147483000',
            minWidth: '160px',
            padding: '8px 10px',
            borderRadius: 'var(--dsw-radius-xl, 10px)',
            border: '1px solid var(--dsw-alias-border-l2, GrayText)',
            background: 'var(--dsw-alias-bg-layer-2, Canvas)',
            color: 'var(--dsw-alias-label-primary, CanvasText)',
            boxShadow: '0 6px 24px rgba(0, 0, 0, 0.25)',
            font: 'inherit',
            fontSize: '12px',
            lineHeight: '1.4'
          }
        }, row);
        var shown = popover;
        try {
          if (ReactDOM && typeof ReactDOM.createPortal === 'function' && typeof document !== 'undefined') {
            shown = ReactDOM.createPortal(popover, document.body);
          }
        } catch (ignored) {
          shown = popover;
        }
        return h('span', {
          style: {
            order: 2,
            position: 'relative',
            display: 'inline-flex',
            alignItems: 'center',
            height: '20px',
            marginLeft: '2px'
          }
        }, h('button', {
          type: 'button',
          ref: buttonRef,
          'aria-haspopup': 'dialog',
          'aria-expanded': open ? 'true' : 'false',
          'aria-label': 'Bytes cremated by CREMATOR this session',
          title: 'CREMATOR removals in this session',
          onClick: onClick,
          onMouseEnter: function () { setHovered(true); },
          onMouseLeave: function () { setHovered(false); },
          onFocus: function () { setFocused(true); },
          onBlur: function () { setFocused(false); },
          style: buttonStyle
        }, h('svg', {
          width: '14',
          height: '14',
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: '1.4',
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false'
        }, h('path', {
          d: 'M8 14c2.6 0 4.4-1.8 4.4-4.1 0-2-1.2-3.4-2.2-4.6-.5-.7-.9-1.4-1-2.2-1.7.9-2.8 2.3-2.8 3.8 0 .7.2 1.3.6 1.8-1.3-.2-2-1.3-2-2.5C3.7 7.8 3.1 9 3.1 10.3 3.1 12.6 5.2 14 8 14Z'
        }))), open && position ? shown : null);
      } catch (error) {
        return null;
      }
    }

    function apply(ctx) {
      try {
        var hasSlots = !!(ctx && ctx.slots);
        try {
          if (typeof console !== 'undefined' && console && typeof console.info === 'function') {
            console.info('[cremator-dsh] apply hasSlots=' + hasSlots);
          }
        } catch (error) { /* diagnostics only */ }
        if (!ctx || !ctx.slots || typeof ctx.slots.inject !== 'function'
          || typeof ctx.slots.register !== 'function') return;
        ctx.slots.inject('conversation.composer.dock', function () {
          try {
            return ctx.slots.register({
              name: 'conversation.composer.dock',
              id: 'cremator-bytes',
              order: 2
            }, CrematedCounter);
          } catch (error) {
            warnOnce(error);
            return undefined;
          }
        });
        try {
          if (typeof console !== 'undefined' && console && typeof console.info === 'function') {
            console.info('[cremator-dsh] registered');
          }
        } catch (error) { /* diagnostics only */ }
      } catch (error) {
        warnOnce(error);
      }
    }

    return { inject: ['slots'], apply: apply };
  }

  try {
    if (typeof window !== 'undefined' && window && window.__ModuleLoader__
      && typeof window.__ModuleLoader__.load === 'function') {
      window.__ModuleLoader__.load({ id: 'cremator-dsh', factory: factory });
    }
  } catch (error) {
    warnOnce(error);
  }
})();
