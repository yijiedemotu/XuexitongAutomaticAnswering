(() => {
  'use strict';

  const REQUEST_EVENT = 'cx-auto-answer:request';
  const RESPONSE_EVENT = 'cx-auto-answer:response';

  document.addEventListener(REQUEST_EVENT, event => {
    let message;
    try { message = JSON.parse(event.detail || '{}'); } catch (e) { return; }
    if (!message || typeof message.id !== 'string' || !/^cx-[a-z0-9-]+$/i.test(message.id)) return;

    let result = false;
    let error = '';
    try {
      const args = message.args || {};
      if (message.command === 'choice') {
        const allowed = ['addChoice', 'addMultipleChoice'];
        const fnName = allowed.includes(args.functionName) ? args.functionName : '';
        const elementId = String(args.elementId || '');
        const element = /^choice-\d+-\d+$/.test(elementId)
          ? document.querySelector(`[data-cx-auto-bridge-id="${elementId}"]`)
          : null;
        if (fnName && element && typeof window[fnName] === 'function') {
          window[fnName].call(window, element);
          result = true;
        }
      } else if (message.command === 'callback') {
        if (args.functionName === 'answerContentChange' && typeof window.answerContentChange === 'function') {
          window.answerContentChange.call(window);
          result = true;
        }
      } else if (message.command === 'write-editor') {
        const editorId = String(args.editorId || '');
        const textareaId = String(args.textareaId || '');
        const textarea = textareaId ? document.getElementById(textareaId) : null;
        const ue = window.UE;
        if (/^answer(?:Editor)?\d+$/.test(editorId) && textarea && textarea.tagName === 'TEXTAREA' &&
            ue && typeof ue.getEditor === 'function') {
          const editor = ue.getEditor(editorId);
          if (editor && typeof editor.setContent === 'function') {
            editor.setContent(String(args.value || ''));
            if (typeof editor.sync === 'function') editor.sync();
            if (editor.body && typeof editor.body.dispatchEvent === 'function') {
              editor.body.dispatchEvent(new Event('input', { bubbles: true }));
            }
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            textarea.dispatchEvent(new Event('change', { bubbles: true }));
            if (typeof window.answerContentChange === 'function') window.answerContentChange.call(window);
            result = true;
          }
        }
      } else if (message.command === 'read-editor') {
        const editorId = String(args.editorId || '');
        const textareaId = String(args.textareaId || '');
        const textarea = textareaId ? document.getElementById(textareaId) : null;
        const ue = window.UE;
        if (/^answer(?:Editor)?\d+$/.test(editorId) && textarea && textarea.tagName === 'TEXTAREA' &&
            ue && typeof ue.getEditor === 'function') {
          const editor = ue.getEditor(editorId);
          if (editor) {
            const text = typeof editor.getContentTxt === 'function'
              ? editor.getContentTxt()
              : typeof editor.getContent === 'function' ? editor.getContent() : textarea.value;
            result = String(text || textarea.value || '');
          }
        }
      } else if (message.command === 'save-question') {
        const qid = String(args.qid || '');
        if (/^\d+$/.test(qid)) {
          if (typeof window.saveQuestion === 'function') {
            window.saveQuestion(qid, qid);
            result = true;
          } else if (typeof window.submitForm === 'function') {
            const jq = window.jQuery || window.$;
            if (typeof jq === 'function') {
              window.submitForm(true, jq('#sigleQuestionDiv_' + qid));
              result = true;
            }
          }
        }
      } else if (message.command === 'submit-work') {
        if (typeof window.submitValidate === 'function') {
          window.submitValidate.call(window, 0);
          result = true;
        }
      }
    } catch (cause) {
      error = cause && cause.message || String(cause);
    }

    document.dispatchEvent(new CustomEvent(RESPONSE_EVENT, {
      detail: JSON.stringify({ id: message.id, ok: !error, result, error })
    }));
  });
})();
