/* VX0 · comportamiento del prototipo (no entra al build).
   - Estado global en atributos de <html>: data-vertical, data-state,
     data-motion, data-grid, data-embed. Se fijan ANTES del primer pintado
     (este script va sincrónico en <head>) para que no haya parpadeo.
   - Los parámetros de URL mandan (?vertical=general&state=error&embed=1);
     si no hay, se usa lo último elegido (localStorage, con try/catch: en
     iframes, previews o modo privado puede tirar).
   - Las piezas repetidas (header, precios, FAQ, contacto, footer y los
     formularios de auth) se inyectan desde acá para que las tres
     direcciones muestren exactamente el mismo contenido. */
(function () {
  "use strict";
  var root = document.documentElement;
  var params = new URLSearchParams(location.search);
  var STORE = "vx0:";
  function load(k) { try { return localStorage.getItem(STORE + k); } catch (e) { return null; } }
  function save(k, v) { try { localStorage.setItem(STORE + k, v); } catch (e) { /* sin storage */ } }

  var embedded = params.get("embed") === "1";
  try { if (window.self !== window.top) embedded = true; } catch (e) { embedded = true; }

  var S = {
    vertical: params.get("vertical") || load("vertical") || "kine",
    state: params.get("state") || "normal",
    motion: params.get("motion") || (embedded ? null : load("motion")) || "full",
    grid: params.get("grid") || load("grid") || "off",
  };
  /* VX0-c: las pantallas de app (recepcion, sala-tv) declaran sus propios
     controles ANTES de cargar este script:
       window.VX_PAGE = { bar: "app",            // sin Vertical/Estado
         extra: [{ k: "layout", label: "Variante", def: "a", opts: [["a", "A"], ["b", "B"]] }],
         actions: [{ label: "Simular llamado", run: function () {…} }] };
     Cada extra queda en <html data-<k>>, la URL manda (?layout=b) y avisa
     con el evento "vx:change" ({ k, v }) para que la página re-renderice. */
  var PAGE = window.VX_PAGE || null;
  var EXTRA = (PAGE && PAGE.extra) || [];
  EXTRA.forEach(function (x) {
    S[x.k] = params.get(x.k) || (embedded ? null : load(x.k)) || x.def;
  });
  function apply() {
    root.setAttribute("data-vertical", S.vertical);
    root.setAttribute("data-state", S.state);
    root.setAttribute("data-motion", S.motion);
    root.setAttribute("data-grid", S.grid);
    EXTRA.forEach(function (x) { root.setAttribute("data-" + x.k, S[x.k]); });
    if (embedded) root.setAttribute("data-embed", "1");
  }
  window.VX_STATE = S;
  apply();

  /* ── Íconos (trazo 1.8, 24 px, currentColor) ─────────────────── */
  var I = {
    google:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M23.52 12.27c0-.85-.08-1.67-.22-2.45H12v4.64h6.46a5.52 5.52 0 0 1-2.4 3.62v3h3.88c2.27-2.09 3.58-5.17 3.58-8.81z"/><path fill="#34A853" d="M12 24c3.24 0 5.96-1.07 7.94-2.9l-3.88-3.01c-1.07.72-2.45 1.15-4.06 1.15-3.13 0-5.78-2.11-6.72-4.95H1.27v3.11A12 12 0 0 0 12 24z"/><path fill="#FBBC05" d="M5.28 14.29A7.2 7.2 0 0 1 4.9 12c0-.8.14-1.57.38-2.29V6.6H1.27A12 12 0 0 0 0 12c0 1.94.46 3.77 1.27 5.4l4.01-3.11z"/><path fill="#EA4335" d="M12 4.77c1.76 0 3.34.61 4.59 1.8l3.44-3.44A11.97 11.97 0 0 0 12 0 12 12 0 0 0 1.27 6.6l4.01 3.11C6.22 6.88 8.87 4.77 12 4.77z"/></svg>',
    facebook:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#0866FF" d="M24 12.07C24 5.4 18.63 0 12 0S0 5.4 0 12.07C0 18.1 4.39 23.1 10.13 24v-8.44H7.08v-3.49h3.05V9.41c0-3.02 1.79-4.69 4.53-4.69 1.31 0 2.68.24 2.68.24v2.97h-1.51c-1.49 0-1.96.93-1.96 1.89v2.25h3.33l-.53 3.49h-2.8V24C19.61 23.1 24 18.1 24 12.07z"/><path fill="#fff" d="m16.67 15.56.53-3.49h-3.33V9.82c0-.96.47-1.89 1.96-1.89h1.51V4.96s-1.37-.24-2.68-.24c-2.74 0-4.53 1.67-4.53 4.69v2.66H7.08v3.49h3.05V24a12.2 12.2 0 0 0 3.74 0v-8.44z"/></svg>',
    eye:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
    eyeOff:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.6 5.1A10.8 10.8 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-2.9 3.8M6.6 6.6C3.6 8.5 2 12 2 12s3.6 7 10 7a10 10 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/><path d="m3 3 18 18"/></svg>',
    alert:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9.5"/><path d="M12 7.5v5.5"/><circle cx="12" cy="16.5" r=".6" fill="currentColor"/></svg>',
    check:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
    checkCircle:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9.5"/><path d="m8 12.3 2.8 2.7L16.2 9.5"/></svg>',
    plus:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
    menu:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
    close:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>',
    arrow:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" width="18" height="18"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
    mail:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="m4 7 8 6 8-6"/></svg>',
    tag:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12V4.5A1.5 1.5 0 0 1 4.5 3H12l9 9-9 9z"/><circle cx="8" cy="8" r="1.5"/></svg>',
    building:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16M16 9h2a2 2 0 0 1 2 2v10M3 21h18M8 7h4M8 11h4M8 15h4"/></svg>',
    help:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9.5"/><path d="M9.5 9.2a2.6 2.6 0 0 1 5 .9c0 1.7-2.5 2.3-2.5 3.9"/><circle cx="12" cy="17" r=".6" fill="currentColor"/></svg>',
  };
  var LOGO_MARK =
    '<span class="logo-mark" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none"><circle cx="7" cy="6" r="2.5" fill="currentColor"/><path d="M6 9.5C6 12 7.5 13 8 14.5L6 21" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><path d="M9 11.5L13 12.5L16 10.5L19 16" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="17.5" cy="6.5" r="1.6" fill="#c8f564"/></svg></span>';
  function logo(href, light) {
    return '<a class="logo' + (light ? " logo--light" : "") + '" href="' + href + '" aria-label="KineSoft, inicio">' +
      LOGO_MARK + '<span class="logo-word" aria-hidden="true">KineSoft</span></a>';
  }

  /* ── Piezas ──────────────────────────────────────────────────── */
  var NAV = [
    ["#funciones", "Funciones"],
    ["#kinesiologia", "Kinesiología"],
    ["#como-empezar", "Cómo empezás"],
    ["#precios", "Precios"],
    ["#preguntas", "Preguntas"],
  ];
  var T = {};
  T.header = function () {
    var links = NAV.map(function (n) { return '<a href="' + n[0] + '">' + n[1] + "</a>"; }).join("");
    var items = NAV.concat([["#contacto", "Contacto"]]).map(function (n) {
      return '<li><a href="' + n[0] + '">' + n[1] + "</a></li>";
    }).join("");
    return '<a class="skip-link" href="#main">Saltar al contenido</a>' +
      '<header class="site-header"><div class="container nav">' + logo("#top") +
      '<nav class="nav-links" aria-label="Secciones">' + links + "</nav>" +
      '<div class="nav-cta"><a class="btn btn-ghost btn-sm" href="login-b.html">Ingresar</a>' +
      '<a class="btn btn-primary btn-sm" href="signup.html">Probá 14 días gratis</a></div>' +
      '<button class="nav-toggle" type="button" aria-expanded="false" aria-controls="nav-panel" aria-label="Abrir menú">' + I.menu + "</button>" +
      "</div>" +
      '<div class="nav-panel" id="nav-panel" hidden><nav aria-label="Secciones"><ul>' + items + "</ul></nav>" +
      '<div class="nav-panel-cta"><a class="btn btn-primary btn-block" href="signup.html">Probá 14 días gratis</a>' +
      '<a class="btn btn-ghost btn-block" href="login-b.html">Ingresar</a></div></div></header>';
  };

  T.steps = function () {
    return '<div class="section-head"><span class="eyebrow"><span class="eyebrow-dot"></span>Cómo empezás</span>' +
      '<h2 class="h2" id="como-empezar-title">En una tarde, tu consultorio queda andando</h2></div>' +
      '<ol class="steps" role="list">' +
      '<li class="step"><h3 class="h3">Creá tu cuenta</h3><p class="muted">Con Google, Facebook o tu email. El plan Individual tiene 14 días gratis y no te pide medio de pago.</p></li>' +
      '<li class="step"><h3 class="h3">Cargá servicios y horarios</h3><p class="muted">Definís qué atendés, cuánto dura cada turno y en qué días y horarios trabaja cada profesional.</p></li>' +
      '<li class="step"><h3 class="h3">Compartí tu turnero</h3><p class="muted">Tus pacientes reservan desde el link de tu consultorio. Vos ves todo en la agenda.</p></li>' +
      "</ol>";
  };

  function li(text, only) {
    return "<li" + (only ? ' data-only="' + only + '"' : "") + ">" + I.check + "<span>" + text + "</span></li>";
  }
  T.pricing = function () {
    var sample = '<span class="price-sample">' + I.tag.replace("<svg", '<svg width="14" height="14"') + "Precio de ejemplo</span>";
    function card(name, forWho, amount, items, cta, href, featured) {
      return '<article class="card price-card' + (featured ? " is-featured" : "") + '" aria-labelledby="plan-' + name + '">' +
        '<div style="display:grid;gap:8px"><h3 class="price-name" id="plan-' + name + '">' + name + "</h3>" +
        '<p class="price-for">' + forWho + "</p></div>" +
        '<div style="display:grid;gap:10px"><p class="price-amount"><strong>' + amount + "</strong><span>por mes</span></p>" + sample + "</div>" +
        '<div class="price-sep"></div><ul class="price-list" role="list">' + items + "</ul>" +
        '<a class="btn ' + (featured ? "btn-primary" : "btn-ghost") + ' btn-block" href="' + href + '">' + cta + "</a></article>";
    }
    return '<div class="section-head center"><span class="eyebrow"><span class="eyebrow-dot"></span>Precios</span>' +
      '<h2 class="h2" id="precios-title">Un plan para cada tamaño de consultorio</h2>' +
      '<p class="lead">Empezás con 14 días gratis. Cambiás de plan cuando lo necesites.</p></div>' +
      '<div class="pricing">' +
      card("Individual", "Para quien atiende por su cuenta.", "$ 18.000",
        li("14 días gratis, sin medio de pago") + li("1 usuario") +
        li("Agenda, turnos online e historia clínica") + li("Cobros de copago y obra social") +
        li("Planes de tratamiento y tus propios ejercicios", "kine"),
        "Empezá gratis", "signup.html", false) +
      card("Consultorio", "Para un equipo chico con alguien en el mostrador.", "$ 64.000",
        li("Hasta 4 profesionales") + li("1 usuario de secretaría o administración") +
        li("Todo lo del plan Individual") + li("Agenda de cada profesional, lado a lado") +
        li("Catálogo de ejercicios, plantillas y favoritos", "kine"),
        "Elegir Consultorio", "signup.html", true) +
      card("Clínica", "Para consultorios con varias salas y recepción.", "$ 112.000",
        li("Hasta 10 usuarios, de cualquier rol") + li("Salas y sala de espera") +
        li("Todo lo del plan Consultorio") + li("Recepción: llegadas y llamados al paciente"),
        "Elegir Clínica", "signup.html", false) +
      "</div>" +
      '<div class="price-band"><div><p class="h3">¿Hospital o clínica grande? Hablemos.</p>' +
      "<p>Si necesitás más de 10 usuarios, armamos el plan Libre a la medida de tu equipo.</p></div>" +
      '<a class="btn btn-lime btn-lg" href="#contacto">Escribinos ' + I.arrow + "</a></div>" +
      '<p class="price-note">Precios en pesos argentinos. Los montos de esta maqueta son de ejemplo: en la web salen de Plataforma.</p>';
  };

  function q(question, answer, open) {
    return "<details" + (open ? " open" : "") + "><summary>" + question + I.plus + "</summary><div>" + answer + "</div></details>";
  }
  T.faq = function () {
    return '<div class="section-head center"><span class="eyebrow"><span class="eyebrow-dot"></span>Preguntas</span>' +
      '<h2 class="h2" id="preguntas-title">Lo que más nos preguntan</h2></div><div class="faq">' +
      q("¿Necesito tarjeta para probar?", "No. El plan Individual tiene 14 días gratis y no te pedimos medio de pago para empezar.", true) +
      q("¿Sirve si mi consultorio no es de kinesiología?", "Sí. Con Clínica general tenés pacientes, turnos e historia clínica. Kinesiología suma planes de tratamiento, ejercicios, terapia manual y seguimiento.") +
      q("¿Cómo reservan turno mis pacientes?", "Desde el link público de tu consultorio: eligen profesional, servicio y horario. Si lo activás, pagan con Mercado Pago al reservar.") +
      q("¿Quién ve la historia clínica?", "Los profesionales. La secretaría y la administración manejan la agenda y los datos de contacto, sin entrar a la historia clínica.") +
      q("¿Puedo cambiar de plan?", "Sí, cuando quieras. Si pasás a un plan con menos usuarios, elegís quiénes dejan de tener acceso. Nadie se borra.") +
      q("¿Cómo pago?", "Con débito automático de Mercado Pago o con un pago manual: subís el comprobante y queda imputado.") +
      "</div>";
  };

  T.contact = function () {
    return '<div class="contact"><div class="contact-aside">' +
      '<span class="eyebrow"><span class="eyebrow-dot"></span>Contacto</span>' +
      '<h2 class="h2" id="contacto-title">Hablemos</h2>' +
      '<p class="lead">Contanos cómo trabaja tu consultorio. Te respondemos por email.</p>' +
      '<ul role="list"><li>' + I.tag + "<span>Dudas sobre planes y precios</span></li>" +
      "<li>" + I.building + "<span>Equipos de más de 10 usuarios (plan Libre)</span></li>" +
      "<li>" + I.help + "<span>Ayuda para empezar o pasar tu agenda</span></li></ul></div>" +
      '<div class="card"><form class="contact-form" novalidate data-demo="contact" aria-labelledby="contacto-title">' +
      '<div class="alert alert-success" role="status" data-when="success">' + I.checkCircle +
      "<span><strong>Recibimos tu consulta.</strong> Te respondemos al email que dejaste.</span></div>" +
      '<div class="alert" role="alert" data-when="error">' + I.alert +
      "<span><strong>No pudimos enviar tu consulta.</strong> Probá de nuevo en unos minutos.</span></div>" +
      '<div class="form-2"><div class="field"><label class="label" for="c-name">Nombre</label>' +
      '<input class="input" id="c-name" name="name" autocomplete="name" required></div>' +
      '<div class="field"><label class="label" for="c-email">Email</label>' +
      '<input class="input" id="c-email" name="email" type="email" autocomplete="email" inputmode="email" required></div></div>' +
      '<div class="form-2"><div class="field"><div class="field-row"><label class="label" for="c-phone">Teléfono</label><span class="hint">Opcional</span></div>' +
      '<input class="input" id="c-phone" name="phone" type="tel" autocomplete="tel" inputmode="tel"></div>' +
      '<div class="field"><label class="label" for="c-type">Tu consultorio</label>' +
      '<select class="input" id="c-type" name="type"><option>Kinesiología</option><option>Clínica general</option><option>Otro</option></select></div></div>' +
      '<div class="field"><label class="label" for="c-msg">Mensaje</label>' +
      '<textarea class="input" id="c-msg" name="message" rows="4" required></textarea></div>' +
      '<div class="hp" aria-hidden="true"><label for="c-web">No completar</label><input id="c-web" name="website" tabindex="-1" autocomplete="off"></div>' +
      '<div><button class="btn btn-primary btn-lg" type="submit" data-submit>' +
      '<span data-when="not-sending">Enviar consulta</span>' +
      '<span data-when="sending" style="display:inline-flex;gap:10px;align-items:center"><span class="spinner" aria-hidden="true"></span>Enviando…</span>' +
      "</button></div></form></div></div>";
  };

  T.footer = function () {
    var links = NAV.concat([["#contacto", "Contacto"], ["login-b.html", "Ingresar"], ["signup.html", "Crear cuenta"]]);
    return '<footer class="site-footer"><div class="container"><div class="footer-grid">' +
      '<div style="display:grid;gap:12px;max-width:360px">' + logo("#top") +
      '<p class="muted small">Agenda, turnos online, historia clínica y cobros para tu consultorio. Con herramientas propias para kinesiología.</p></div>' +
      '<nav aria-label="Pie de página"><ul class="footer-links" role="list">' +
      links.map(function (l) { return '<li><a href="' + l[0] + '">' + l[1] + "</a></li>"; }).join("") +
      "</ul></nav></div>" +
      '<div class="footer-base"><span>© 2026 KineSoft</span><span>Hecho en Argentina</span></div></div></footer>';
  };

  function socialButtons() {
    return '<div class="auth-social">' +
      '<button type="button" class="btn-social" data-submit>' + I.google + "Continuar con Google</button>" +
      '<button type="button" class="btn-social" data-submit>' + I.facebook + "Continuar con Facebook</button></div>";
  }
  function passwordField(id, label, autocomplete, extra) {
    return '<div class="field"><div class="field-row"><label class="label" for="' + id + '">' + label + "</label>" + (extra || "") + "</div>" +
      '<div class="input-wrap"><input class="input" id="' + id + '" name="password" type="password" autocomplete="' + autocomplete + '" required data-invalid-on-error' +
      (autocomplete === "new-password" ? ' minlength="8" aria-describedby="' + id + '-hint"' : "") + ">" +
      '<button type="button" class="input-action" data-toggle-password="' + id + '" aria-pressed="false" aria-label="Mostrar contraseña">' + I.eye + "</button></div>" +
      (autocomplete === "new-password" ? '<p class="hint" id="' + id + '-hint">Al menos 8 caracteres.</p>' : "") + "</div>";
  }
  function submit(label, busy) {
    return '<button class="btn btn-primary btn-lg btn-block" type="submit" data-submit>' +
      '<span data-when="not-sending">' + label + "</span>" +
      '<span data-when="sending" style="display:inline-flex;gap:10px;align-items:center"><span class="spinner" aria-hidden="true"></span>' + busy + "</span></button>";
  }

  T["login-form"] = function () {
    return '<div class="auth-stack">' +
      '<div class="auth-head"><h1 class="auth-title">Ingresá a tu consultorio</h1>' +
      '<p class="auth-sub">Con Google, Facebook o tu email.</p></div>' +
      socialButtons() + '<div class="divider">o con tu email</div>' +
      '<form class="auth-fields" novalidate data-demo="auth">' +
      '<div class="alert" role="alert" id="login-error" data-when="error">' + I.alert +
      "<span><strong>No pudimos ingresar.</strong> El email o la contraseña no coinciden. Revisalos y probá de nuevo.</span></div>" +
      '<div class="field"><label class="label" for="email">Email</label>' +
      '<input class="input" id="email" name="email" type="email" autocomplete="email" inputmode="email" placeholder="nombre@ejemplo.com" required data-invalid-on-error></div>' +
      passwordField("password", "Contraseña", "current-password", '<a class="link small" href="#olvide">¿Olvidaste tu contraseña?</a>') +
      submit("Ingresar", "Ingresando…") + "</form>" +
      '<p class="auth-foot">¿Todavía no tenés cuenta? <a class="link" href="signup.html">Creá tu consultorio</a></p></div>';
  };

  T["signup-form"] = function () {
    return '<div class="auth-stack">' +
      '<div class="auth-head"><h1 class="auth-title">Creá tu consultorio</h1>' +
      '<p class="auth-sub">Plan Individual con 14 días gratis. No te pedimos medio de pago.</p></div>' +
      socialButtons() + '<div class="divider">o con tu email</div>' +
      '<form class="auth-fields" novalidate data-demo="auth">' +
      '<div class="alert" role="alert" data-when="error">' + I.alert +
      '<span><strong>Ya hay una cuenta con ese email.</strong> <a class="link" href="login-b.html" style="color:inherit;text-decoration:underline">Ingresá</a> o recuperá tu contraseña.</span></div>' +
      '<div class="field"><label class="label" for="name">Nombre y apellido</label>' +
      '<input class="input" id="name" name="name" autocomplete="name" required></div>' +
      '<div class="field"><label class="label" for="email">Email</label>' +
      '<input class="input" id="email" name="email" type="email" autocomplete="email" inputmode="email" placeholder="nombre@ejemplo.com" required data-invalid-on-error></div>' +
      passwordField("password", "Contraseña", "new-password") +
      '<fieldset class="choice"><legend class="label">Tu consultorio es de</legend><div class="choice-grid">' +
      '<label class="choice-opt"><input type="radio" name="vertical" value="kine" data-vertical-radio><span><strong>Kinesiología</strong><small>Planes, ejercicios y seguimiento</small></span></label>' +
      '<label class="choice-opt"><input type="radio" name="vertical" value="general" data-vertical-radio><span><strong>Clínica general</strong><small>Pacientes, turnos e historia clínica</small></span></label>' +
      "</div></fieldset>" +
      submit("Crear cuenta", "Creando tu cuenta…") + "</form>" +
      '<p class="auth-foot">¿Ya tenés cuenta? <a class="link" href="login-b.html">Ingresá</a></p></div>';
  };

  /* Mock de agenda en CSS (D-VX3): sin cifras de negocio ni nombres
     inventados. Profesional = avatar con iniciales (canal no cromático);
     barra lateral = servicio; fondo = estado (mismos tokens --st-* y --rc-*
     de la app). data-cols = 2..4 profesionales, data-rows = horas. */
  var PROS = [["AL", "#1f4fbe"], ["MR", "#3d7010"], ["JP", "#5e92cc"], ["SG", "#0f3781"]];
  var APPTS = [
    // [col, start(h*2), dur(medias horas), estado, color servicio, kine, general]
    [0, 0, 2, "st-completed", "#1f4fbe", "Sesión de kinesiología", "Consulta"],
    [0, 2, 1, "st-attending", "#8ecc30", "Evaluación inicial", "Primera consulta"],
    [0, 4, 2, "st-confirmed", "#1f4fbe", "Sesión de kinesiología", "Consulta"],
    [0, 7, 2, "st-pending", "#5e92cc", "Terapia manual", "Control"],
    [1, 1, 2, "st-insala", "#3d7010", "Osteopatía", "Consulta"],
    [1, 4, 1, "st-confirmed", "#8ecc30", "Evaluación inicial", "Primera consulta"],
    [1, 6, 2, "st-confirmed", "#3d7010", "Osteopatía", "Control"],
    [2, 0, 1, "st-completed", "#5e92cc", "Terapia manual", "Control"],
    [2, 2, 2, "st-confirmed", "#1f4fbe", "Sesión de kinesiología", "Consulta"],
    [2, 6, 1, "st-pending", "#8ecc30", "Evaluación inicial", "Primera consulta"],
    [3, 1, 2, "st-confirmed", "#3d7010", "Osteopatía", "Consulta"],
    [3, 5, 2, "st-pending", "#1f4fbe", "Sesión de kinesiología", "Control"],
  ];
  var STATUS = { "st-completed": "Atendido", "st-attending": "En atención", "st-confirmed": "Confirmado", "st-pending": "Pendiente", "st-insala": "En sala" };
  T.agenda = function (el) {
    var cols = Math.max(1, Math.min(4, parseInt(el.getAttribute("data-cols") || "2", 10)));
    var rows = parseInt(el.getAttribute("data-rows") || "5", 10);
    var cls = el.getAttribute("class") || "";
    var only = el.getAttribute("data-only");
    var hours = "";
    for (var h = 0; h < rows; h++) hours += "<span>" + String(8 + h).padStart(2, "0") + ":00</span>";
    var heads = "", bodies = "";
    for (var c = 0; c < cols; c++) {
      heads += '<div class="ag-head"><span class="avatar" style="background:' + PROS[c][1] + '">' + PROS[c][0] + '</span><span class="mock-bar w55"></span></div>';
      var items = APPTS.filter(function (a) { return a[0] === c && a[1] + a[2] <= rows * 2; }).map(function (a) {
        return '<div class="appt ' + a[3] + (a[2] === 1 ? " short" : "") + '" style="--svc:' + a[4] + ";top:calc(var(--ag-row) * " + a[1] / 2 + " + 2px);height:calc(var(--ag-row) * " + a[2] / 2 + ' - 4px)">' +
          '<span class="appt-t"><span data-only="kine">' + a[5] + '</span><span data-only="general">' + a[6] + "</span></span>" +
          (a[2] > 1 ? '<span class="appt-s">' + STATUS[a[3]] + "</span>" : "") + "</div>";
      }).join("");
      bodies += '<div class="ag-col">' + items + "</div>";
    }
    return '<div class="mock agenda-mock ' + cls + '"' + (only ? ' data-only="' + only + '"' : "") + ' style="--ag-cols:' + cols + ";--ag-rows:" + rows + '" aria-hidden="true">' +
      '<div class="ag-top"><strong>Agenda</strong><span class="ag-seg"><span class="on">Día</span><span>Semana</span><span>Lista</span></span><span class="mock-bar w30" style="margin-left:auto;max-width:120px"></span></div>' +
      '<div class="ag-grid"><div class="ag-corner"></div>' + heads + '<div class="ag-hours">' + hours + "</div>" + bodies + "</div></div>";
  };

  T.logo = function () { return logo("index.html"); };
  T["logo-light"] = function () { return logo("index.html", true); };

  /* ── Comportamiento ─────────────────────────────────────────── */
  function syncState() {
    var sending = S.state === "sending";
    document.querySelectorAll("[data-submit]").forEach(function (b) {
      if (sending) { b.setAttribute("aria-disabled", "true"); b.setAttribute("aria-busy", "true"); }
      else { b.removeAttribute("aria-disabled"); b.removeAttribute("aria-busy"); }
    });
    document.querySelectorAll("[data-invalid-on-error]").forEach(function (el) {
      if (S.state === "error") { el.setAttribute("aria-invalid", "true"); el.setAttribute("aria-errormessage", "login-error"); }
      else { el.removeAttribute("aria-invalid"); el.removeAttribute("aria-errormessage"); }
    });
    document.querySelectorAll("[data-vertical-radio]").forEach(function (r) { r.checked = r.value === S.vertical; });
    document.querySelectorAll('[data-seg="vertical"]').forEach(function (g) { syncSeg(g, S.vertical); });
    document.querySelectorAll(".vx-bar [data-k]").forEach(function (b) {
      b.setAttribute("aria-pressed", String(S[b.getAttribute("data-k")] === b.getAttribute("data-v")));
    });
  }
  function set(k, v, persist) {
    S[k] = v;
    if (persist !== false && k !== "state") save(k, v);
    apply();
    syncState();
    try { document.dispatchEvent(new CustomEvent("vx:change", { detail: { k: k, v: v } })); } catch (e) { /* IE */ }
  }
  window.VX_SET = set;

  function syncSeg(group, value) {
    var btns = group.querySelectorAll("[role=radio]");
    var thumb = group.querySelector(".seg-thumb");
    btns.forEach(function (b) {
      var on = b.getAttribute("data-value") === value;
      b.setAttribute("aria-checked", String(on));
      b.tabIndex = on ? 0 : -1;
      if (on && thumb) {
        thumb.style.width = b.offsetWidth + "px";
        thumb.style.transform = "translateX(" + b.offsetLeft + "px)";
      }
    });
  }
  function initSeg(group) {
    var btns = Array.prototype.slice.call(group.querySelectorAll("[role=radio]"));
    btns.forEach(function (b, i) {
      b.addEventListener("click", function () { set("vertical", b.getAttribute("data-value")); });
      b.addEventListener("keydown", function (e) {
        var d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
        if (!d) return;
        e.preventDefault();
        var n = btns[(i + d + btns.length) % btns.length];
        set("vertical", n.getAttribute("data-value"));
        n.focus();
      });
    });
  }

  function buildBar() {
    var bar = document.createElement("div");
    bar.className = "vx-bar";
    bar.setAttribute("role", "toolbar");
    bar.setAttribute("aria-label", "Controles del prototipo");
    function grp(label, k, opts) {
      return '<span class="vx-label">' + label + '</span><div class="vx-group">' + opts.map(function (o) {
        return '<button type="button" data-k="' + k + '" data-v="' + o[0] + '" aria-pressed="false">' + o[1] + "</button>";
      }).join("") + "</div>";
    }
    var isLanding = !!document.querySelector("[data-include=contact]");
    var appBar = PAGE && PAGE.bar === "app";
    bar.innerHTML =
      '<a class="vx-home" href="index.html">← Galería</a>' +
      (appBar ? "" :
        grp("Vertical", "vertical", [["kine", "Kinesiología"], ["general", "Clínica general"]]) +
        grp("Estado", "state", [["normal", "Normal"], ["error", "Error"], ["sending", "Enviando"]].concat(isLanding ? [["success", "Enviado"]] : []))) +
      EXTRA.map(function (x) { return grp(x.label, x.k, x.opts); }).join("") +
      ((PAGE && PAGE.actions) || []).map(function (a, i) {
        return '<div class="vx-group"><button type="button" data-act="' + i + '">' + a.label + "</button></div>";
      }).join("") +
      grp("Motion", "motion", [["full", "Animado"], ["reduce", "Reducido"]]) +
      grp("Grilla", "grid", [["off", "No"], ["on", "8 px"]]) +
      '<button type="button" class="vx-collapse" aria-expanded="true">Ocultar</button>';
    document.body.appendChild(bar);
    bar.addEventListener("click", function (e) {
      var b = e.target.closest("button");
      if (!b) return;
      if (b.classList.contains("vx-collapse")) {
        var c = bar.classList.toggle("is-collapsed");
        b.textContent = c ? "Prototipo" : "Ocultar";
        b.setAttribute("aria-expanded", String(!c));
        save("bar", c ? "collapsed" : "open");
        return;
      }
      if (b.hasAttribute("data-act")) { var a = PAGE.actions[+b.getAttribute("data-act")]; if (a && a.run) a.run(); return; }
      if (b.hasAttribute("data-k")) set(b.getAttribute("data-k"), b.getAttribute("data-v"));
    });
    var startCollapsed = load("bar") === "collapsed" || (load("bar") === null && window.innerWidth < 768);
    if (startCollapsed) bar.querySelector(".vx-collapse").click();
  }

  document.addEventListener("DOMContentLoaded", function () {
    document.querySelectorAll("[data-include]").forEach(function (el) {
      var fn = T[el.getAttribute("data-include")];
      if (fn) el.outerHTML = fn(el);
    });

    // Mostrar/ocultar contraseña (D-VX12). aria-pressed + label que cambia.
    document.querySelectorAll("[data-toggle-password]").forEach(function (b) {
      b.addEventListener("click", function () {
        var input = document.getElementById(b.getAttribute("data-toggle-password"));
        var show = input.type === "password";
        input.type = show ? "text" : "password";
        b.setAttribute("aria-pressed", String(show));
        b.setAttribute("aria-label", show ? "Ocultar contraseña" : "Mostrar contraseña");
        b.innerHTML = show ? I.eyeOff : I.eye;
      });
    });

    // Menú mobile: aria-expanded, Escape cierra y devuelve el foco.
    var toggle = document.querySelector(".nav-toggle");
    var panel = document.getElementById("nav-panel");
    if (toggle && panel) {
      var setOpen = function (open) {
        panel.hidden = !open;
        toggle.setAttribute("aria-expanded", String(open));
        toggle.setAttribute("aria-label", open ? "Cerrar menú" : "Abrir menú");
        toggle.innerHTML = open ? I.close : I.menu;
      };
      toggle.addEventListener("click", function () { setOpen(panel.hidden); });
      panel.addEventListener("click", function (e) { if (e.target.closest("a")) setOpen(false); });
      document.addEventListener("keydown", function (e) {
        if (e.key === "Escape" && !panel.hidden) { setOpen(false); toggle.focus(); }
      });
      window.addEventListener("resize", function () { if (window.innerWidth >= 1024) setOpen(false); });
      if (params.get("menu") === "open") setOpen(true);
    }

    document.querySelectorAll('[data-seg="vertical"]').forEach(initSeg);
    document.querySelectorAll("[data-vertical-radio]").forEach(function (r) {
      r.addEventListener("change", function () { if (r.checked) set("vertical", r.value); });
    });

    // Envío simulado: enviando 1,2 s → error (auth) o enviado (contacto).
    document.querySelectorAll("form[data-demo]").forEach(function (f) {
      f.addEventListener("submit", function (e) {
        e.preventDefault();
        if (S.state === "sending") return;
        set("state", "sending");
        setTimeout(function () { set("state", f.getAttribute("data-demo") === "contact" ? "success" : "error"); }, 1200);
      });
    });

    if (!embedded && params.get("bar") !== "0") buildBar();
    syncState();
    // Las fuentes cambian el ancho de los botones: recalcula el thumb.
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(syncState);
    window.addEventListener("resize", syncState);
  });
})();
