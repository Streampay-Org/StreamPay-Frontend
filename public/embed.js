(function () {
  "use strict";

  var SCRIPT_SELECTOR = "script[src*='/embed.js']";
  var WIDGET_SELECTOR = "[data-streampay-stream]";
  var MAX_HEIGHT = 1200;
  var MIN_HEIGHT = 100;

  function initializeWidget(element, scriptUrl) {
    if (element.dataset.streampayInitialized === "true") return;

    var streamId = element.getAttribute("data-streampay-stream");
    var token = element.getAttribute("data-token");

    if (!streamId || !token) {
      console.error(
        "StreamPay: data-streampay-stream and data-token are required.",
      );
      return;
    }

    var widgetUrl = new URL(
      "/embed/stream/" + encodeURIComponent(streamId),
      scriptUrl.origin,
    );

    widgetUrl.searchParams.set("t", token);

    var iframe = document.createElement("iframe");

    iframe.src = widgetUrl.toString();
    iframe.title = "StreamPay payment stream";
    iframe.loading = "lazy";
    iframe.referrerPolicy = "no-referrer";
    iframe.setAttribute("sandbox", "allow-scripts allow-same-origin");
    iframe.style.width = "100%";
    iframe.style.height = "360px";
    iframe.style.border = "0";
    iframe.style.display = "block";
    iframe.style.overflow = "hidden";

    element.dataset.streampayInitialized = "true";
    element.appendChild(iframe);

    window.addEventListener("message", function (event) {
      if (event.origin !== widgetUrl.origin) return;
      if (event.source !== iframe.contentWindow) return;

      var data = event.data;

      if (
        !data ||
        data.type !== "streampay:resize" ||
        !Number.isFinite(data.height)
      ) {
        return;
      }

      var height = Math.min(
        MAX_HEIGHT,
        Math.max(MIN_HEIGHT, Math.ceil(data.height)),
      );

      iframe.style.height = height + "px";
    });
  }

  function initialize() {
    var script = document.currentScript;

    if (!script) {
      script = document.querySelector(SCRIPT_SELECTOR);
    }

    if (!script || !script.src) return;

    var scriptUrl;

    try {
      scriptUrl = new URL(script.src, document.baseURI);
    } catch (error) {
      console.error("StreamPay: Invalid embed script URL.");
      return;
    }

    document.querySelectorAll(WIDGET_SELECTOR).forEach(function (element) {
      initializeWidget(element, scriptUrl);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialize);
  } else {
    initialize();
  }
})();