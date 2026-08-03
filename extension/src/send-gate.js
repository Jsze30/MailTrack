// Register before Gmail so its Send handler cannot serialize an unprepared body.

(() => {
  "use strict";

  const resumedButtons = new WeakSet();
  let sendHandler = null;
  let scheduleHandler = null;
  let scheduleOriginButton = null;

  function actionLabel(element) {
    return (
      element.getAttribute("data-tooltip") ||
      element.getAttribute("aria-label") ||
      element.textContent ||
      ""
    ).trim();
  }

  function clickedSendButtonFrom(target) {
    if (!(target instanceof Element)) return null;
    const clicked = target.closest('[role="button"][data-tooltip]');
    if (!clicked) return null;
    const tooltip = (clicked.getAttribute("data-tooltip") || "").trim();
    return /^send\b/i.test(tooltip) && !/schedule/i.test(tooltip) ? clicked : null;
  }

  function composeSendButtonFrom(target) {
    if (!(target instanceof Element)) return null;
    for (let container = target; container && container !== document.body; container = container.parentElement) {
      const button = [...container.querySelectorAll('[role="button"][data-tooltip]')].find(
        (candidate) => {
          const tooltip = (candidate.getAttribute("data-tooltip") || "").trim();
          return /^send\b/i.test(tooltip) && !/schedule/i.test(tooltip);
        }
      );
      if (button) return button;
    }
    return null;
  }

  function clickedScheduleButtonFrom(target) {
    if (!(target instanceof Element)) return null;
    const clicked = target.closest(
      '[role="menuitem"], [role="button"][data-tooltip], [role="button"][aria-label]'
    );
    return clicked && /^schedule send$/i.test(actionLabel(clicked)) ? clicked : null;
  }

  function clickedSendOptionsButtonFrom(target) {
    if (!(target instanceof Element)) return null;
    const clicked = target.closest('[role="button"][data-tooltip], [role="button"][aria-label]');
    return clicked && /^more send options$/i.test(actionLabel(clicked)) ? clicked : null;
  }

  function intercept(event, sendButton) {
    if (!sendHandler || !sendButton) return;
    if (resumedButtons.has(sendButton)) {
      resumedButtons.delete(sendButton);
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    try {
      sendHandler(event.target, sendButton);
    } catch (error) {
      console.warn("[MailTrack] send gate failed", error);
      resume(sendButton);
    }
  }

  function resume(sendButton) {
    resumedButtons.add(sendButton);
    sendButton.click();
  }

  function interceptSchedule(event, scheduleButton) {
    if (!scheduleHandler || !scheduleButton) return;
    if (resumedButtons.has(scheduleButton)) {
      resumedButtons.delete(scheduleButton);
      return;
    }
    const originButton = scheduleOriginButton;
    scheduleOriginButton = null;
    event.preventDefault();
    event.stopImmediatePropagation();
    try {
      scheduleHandler(event.target, scheduleButton, originButton);
    } catch (error) {
      console.warn("[MailTrack] schedule gate failed", error);
      resume(scheduleButton);
    }
  }

  document.addEventListener(
    "click",
    (event) => {
      const scheduleButton = clickedScheduleButtonFrom(event.target);
      if (scheduleButton) {
        interceptSchedule(event, scheduleButton);
        return;
      }
      const optionsButton = clickedSendOptionsButtonFrom(event.target);
      if (optionsButton) scheduleOriginButton = optionsButton;
      intercept(event, clickedSendButtonFrom(event.target));
    },
    true
  );

  document.addEventListener(
    "keydown",
    (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        intercept(event, composeSendButtonFrom(event.target));
      }
    },
    true
  );

  window.MTGate = {
    onSend(handler) {
      sendHandler = handler;
    },
    onSchedule(handler) {
      scheduleHandler = handler;
    },
    resume,
  };
})();
