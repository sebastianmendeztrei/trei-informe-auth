// ════════════════════════════════════════════════════════════════════════════
// trei-informe-auth — puerta del Informe Comercial
//
// Cambios respecto de la versión actual:
//   1. correoReal()  — lee bien el correo de los invitados externos (#EXT#).
//   2. puedeEntrar() — además del dominio @trei.cl, deja pasar a quien esté en
//                      el padrón del informe, activo y vigente. Así los
//                      externos entran sin necesidad de una lista paralela.
//   3. destinoSeguro() — cierra la redirección abierta del parámetro `state`.
//   4. Validación de `iss` en el id_token.
//   5. SIEMPRE_ACCESO sale del código y pasa a ser una variable de entorno.
//   6. La mantención se lee del KV `trei_mantenimiento` (el que escribe el
//      Panel de Salud) en vez de maintenance.json, que estaba quedando viejo.
//      Requiere el binding MAINTENANCE_KV; sin él, simplemente nunca hay
//      mantención y el portal funciona igual.
//
// Variables a agregar en Cloudflare (ambas son PÚBLICAS, van como Plaintext,
// no como Secret):
//   SUPABASE_URL       = https://owhlpaypipgkihgubvfl.supabase.co
//   SUPABASE_ANON_KEY  = eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im93aGxwYXlwaXBna2loZ3VidmZsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkxOTIzNjEsImV4cCI6MjA5NDc2ODM2MX0.64wndm7q6l3kaParSh1gXw-8QX_9bhbbYUIJyCM-cz0
//   BYPASS_MANTENCION  = smendez@trei.cl        (opcional, separado por comas)
//
// Nada de esto le quita acceso a nadie de @trei.cl: la regla es "dominio
// permitido O padrón". El padrón solo suma.
// ════════════════════════════════════════════════════════════════════════════

// El estado de mantención ya no vive en maintenance.json: el Panel de Salud lo
// escribe en el KV `trei_mantenimiento`. Si el binding MAINTENANCE_KV no está
// configurado, se asume que no hay mantención — el portal nunca queda trabado.
async function estadoMantencion(env) {
  if (!env.MAINTENANCE_KV) return { comercial: false, escrituracion: false };
  try {
    const [c, e] = await Promise.all([
      env.MAINTENANCE_KV.get("comercial"),
      env.MAINTENANCE_KV.get("escrituracion"),
    ]);
    return { comercial: c === "on", escrituracion: e === "on" };
  } catch (_) {
    return { comercial: false, escrituracion: false };
  }
}

const COOKIE_NAME = "trei_session";
const SESSION_TTL_SECONDS = 60 * 60 * 8; // 8 horas
// El funnel de escrituración ahora vive dentro de la carpeta del informe, así
// queda detrás del mismo login de Entra y usa el mismo puente a Supabase.
// Antes apuntaba a funnel-escrituracion.smendez.workers.dev, que entraba con
// una clave escrita en el HTML y la anon key pública.
const ESCRITURACION_URL = "/informe_ventas/escrituracion/";

// ════════════════════════════════════════════════════════════════════════════
// TOUR DE BIENVENIDA
// Se sirve en /informe_ventas/tour.js y el worker lo inyecta al final del
// <body> de cualquier HTML que devuelva. Así el informe (500 KB, publicado por
// SFTP desde otro repositorio) no se toca: para cambiar el tour basta con
// editar este bloque y desplegar el worker.
// ════════════════════════════════════════════════════════════════════════════

const TOUR_JS = `/* ════════════════════════════════════════════════════════════════════════════
   TOUR DE BIENVENIDA — Trei
   Bloque autocontenido: no depende de ninguna librería y no modifica el HTML
   del informe. Se pega al final del <body> y listo.

   Cómo apunta a los elementos: por selector CSS, o por selector + texto
   ({sel:'.sidenav-btn', texto:'Resumen Mes'}). Así no hace falta agregarle
   identificadores al informe.

   Regla importante: si el elemento de un paso no existe o no está visible,
   ese paso SE SALTA. Es lo que permite que el mismo tour sirva para gerencia
   (ve los 7 proyectos) y para alguien limitado a uno solo.
   ════════════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  // ── Configuración ─────────────────────────────────────────────────────────
  const RPC = "/informe_ventas/db/rest/v1/rpc/";   // puente del worker
  const ROJO = "#E1093F";

  // ── Utilidades ────────────────────────────────────────────────────────────
  // Solo se hace scroll cuando de verdad hace falta. Centrar a lo bruto rompe
  // los elementos "pegajosos" (el menú de Gestión Ventas se queda fijo arriba
  // mientras la página baja, y termina mostrándose vacío).
  function acercar(obj) {
    if (!obj) return 0;
    const r = obj.getBoundingClientRect();
    const H = innerHeight, margen = 20;
    if (r.top >= margen && r.bottom <= H - margen) return 0;      // ya se ve entera
    if (r.height > H - margen * 2) {                              // más alta que la pantalla
      if (r.top >= margen && r.top <= H / 2) return 0;            // su parte de arriba ya se ve
      scrollBy({ top: r.top - margen, behavior: "smooth" });
      return 320;
    }
    obj.scrollIntoView({ block: "center", behavior: "smooth" });
    return 320;
  }

  function esVisible(e) {
    const r = e.getBoundingClientRect();
    return !!(e.offsetParent || e.getClientRects().length) && r.width > 0 && r.height > 0;
  }

  // Se queda con el primer candidato VISIBLE, no con el primero del documento:
  // el informe tiene elementos con la misma clase en pestañas distintas, y las
  // que no están activas siguen existiendo, ocultas.
  function buscar(paso) {
    if (!paso.sel) return null;                     // paso centrado, sin objetivo
    let candidatos = [...document.querySelectorAll(paso.sel)].filter(esVisible);
    if (paso.texto) {
      const t = paso.texto.toLowerCase();
      candidatos = candidatos.filter(e => e.textContent.trim().toLowerCase().includes(t));
    }
    return candidatos[0] || null;
  }

  function estilos() {
    if (document.getElementById("tt-css")) return;
    const s = document.createElement("style");
    s.id = "tt-css";
    s.textContent = \`
      .tt-capa{position:fixed;inset:0;z-index:2147483000;pointer-events:none;
        font-family:'Ubuntu',Calibri,system-ui,sans-serif}
      .tt-velo{position:fixed;background:rgba(15,15,20,.62);pointer-events:auto;
        transition:all .28s cubic-bezier(.4,0,.2,1)}
      .tt-marco{position:fixed;border:2.5px solid \${ROJO};border-radius:10px;
        pointer-events:none;box-shadow:0 0 0 4px rgba(225,9,63,.22);
        transition:all .28s cubic-bezier(.4,0,.2,1)}
      .tt-globo{position:fixed;width:330px;max-width:calc(100vw - 32px);background:#fff;
        border-radius:12px;padding:18px 20px 16px;pointer-events:auto;
        box-shadow:0 12px 40px rgba(0,0,0,.28);transition:all .28s cubic-bezier(.4,0,.2,1)}
      .tt-globo.centro{left:50%;top:50%;transform:translate(-50%,-50%);width:400px;text-align:center}
      .tt-flecha{position:absolute;width:12px;height:12px;background:#fff;transform:rotate(45deg)}
      .tt-paso{font-size:10.5px;font-weight:700;letter-spacing:1.3px;text-transform:uppercase;
        color:\${ROJO};margin-bottom:7px}
      .tt-titulo{font-size:16px;font-weight:700;color:#111;margin-bottom:6px;line-height:1.3}
      .tt-texto{font-size:13.5px;color:#5c5c66;line-height:1.55}
      .tt-pie{display:flex;align-items:center;gap:8px;margin-top:16px}
      .tt-puntos{display:flex;gap:5px;margin-right:auto}
      .tt-punto{width:6px;height:6px;border-radius:50%;background:#dcdce2}
      .tt-punto.on{background:\${ROJO};width:16px;border-radius:3px}
      .tt-btn{border:0;border-radius:7px;padding:9px 16px;font-size:13px;font-weight:500;
        cursor:pointer;font-family:inherit}
      .tt-btn.p{background:\${ROJO};color:#fff}
      .tt-btn.s{background:#f0f0f3;color:#555}
      .tt-btn:hover{filter:brightness(.94)}
      .tt-salir{position:absolute;top:12px;right:14px;border:0;background:none;cursor:pointer;
        color:#b8b8c0;font-size:19px;line-height:1;padding:2px 4px}
      .tt-salir:hover{color:#666}
      .tt-pista{font-size:12px;color:\${ROJO};font-weight:500;margin-top:11px;
        display:flex;align-items:center;gap:6px}
      /* Botón para volver a ver la guía. Se mete en la barra de arriba a la
         derecha si encuentra dónde; si no, queda flotando en esa misma esquina. */
      .tt-ayuda{display:inline-flex;align-items:center;gap:5px;border-radius:999px;
        cursor:pointer;font-family:inherit;font-size:11.5px;font-weight:500;
        border:1px solid #d8d8e0;background:transparent;color:#8a8a94;
        padding:3px 10px 3px 4px;line-height:1.5;vertical-align:middle}
      .tt-ayuda:hover{border-color:\${ROJO};color:\${ROJO}}
      .tt-ayuda i{display:inline-flex;align-items:center;justify-content:center;
        width:15px;height:15px;border-radius:50%;background:#e8e8ee;color:#6a6a76;
        font-style:normal;font-size:10.5px;font-weight:700}
      .tt-ayuda:hover i{background:\${ROJO};color:#fff}
      .tt-ayuda.en-linea{margin-left:14px}
      .tt-ayuda.flotante{position:fixed;top:10px;right:16px;z-index:2147482000;
        background:#fff;box-shadow:0 2px 8px rgba(0,0,0,.12)}
      @media(max-width:640px){
        .tt-globo{width:calc(100vw - 24px);left:12px!important;right:12px}
        .tt-flecha{display:none}
      }\`;
    document.head.appendChild(s);
  }

  // ── El motor ──────────────────────────────────────────────────────────────
  function Tour(nombre, pasos) {
    let i = 0, activos = [], capa = null, alLimpiar = null;

    function cerrar(completado) {
      if (alLimpiar) { alLimpiar(); alLimpiar = null; }
      if (capa) { capa.remove(); capa = null; }
      window.removeEventListener("resize", pintar);
      window.removeEventListener("scroll", pintar, true);
      document.removeEventListener("keydown", teclas);
      marcarVisto(nombre, completado);
    }

    function teclas(e) {
      if (e.key === "Escape") cerrar(false);
      if (e.key === "ArrowRight" || e.key === "Enter") ir(1);
      if (e.key === "ArrowLeft") ir(-1);
    }

    // Algunos pasos viven en otra pestaña del informe. \`alEntrar\` la abre antes
    // de pintar el globo, para que el elemento exista cuando lo vayamos a buscar.
    function ir(delta) {
      const siguiente = i + delta;
      if (siguiente < 0) return;
      if (siguiente >= activos.length) return cerrar(true);
      i = siguiente;
      const paso = activos[i];
      // Soltar el "avanzar al hacer clic" del paso anterior ANTES de cambiar de
      // pestaña: si no, el clic que hace el propio tour lo dispara y salta un paso.
      if (alLimpiar) { alLimpiar(); alLimpiar = null; }
      let espera = 0;
      if (typeof paso.alEntrar === "function") {
        try { paso.alEntrar(); espera = paso.esperaAlEntrar || 500; } catch (_) {}
      }
      setTimeout(() => {
        const obj = buscar(paso);
        setTimeout(pintar, acercar(obj));
      }, espera);
    }

    function pintar() {
      if (!capa) return;
      const paso = activos[i];
      const obj = buscar(paso);
      const g = capa.querySelector(".tt-globo");
      const marco = capa.querySelector(".tt-marco");
      const velos = [...capa.querySelectorAll(".tt-velo")];

      // contenido
      capa.querySelector(".tt-paso").textContent = \`Paso \${i + 1} de \${activos.length}\`;
      capa.querySelector(".tt-titulo").textContent = paso.titulo;
      capa.querySelector(".tt-texto").textContent = paso.texto_;
      capa.querySelector(".tt-puntos").innerHTML =
        activos.map((_, n) => \`<span class="tt-punto \${n === i ? "on" : ""}"></span>\`).join("");
      capa.querySelector(".tt-atras").style.visibility = i === 0 ? "hidden" : "visible";
      capa.querySelector(".tt-sig").textContent = i === activos.length - 1 ? "Entendido" : "Siguiente";
      const pista = capa.querySelector(".tt-pista");
      pista.style.display = (obj && paso.alHacerClic) ? "flex" : "none";
      if (obj && paso.alHacerClic) pista.textContent = "→ " + paso.alHacerClic;

      // sin objetivo: globo al centro, velo completo
      if (!obj) {
        marco.style.display = "none";
        g.classList.add("centro");
        g.style.left = ""; g.style.top = "";
        capa.querySelector(".tt-flecha").style.display = "none";
        velos[0].style.cssText = "position:fixed;inset:0;background:rgba(15,15,20,.62);pointer-events:auto";
        velos.slice(1).forEach(v => v.style.cssText = "display:none");
        return;
      }

      const r = obj.getBoundingClientRect();
      const p = 6;
      const x = r.left - p, y = r.top - p, w = r.width + p * 2, h = r.height + p * 2;

      marco.style.display = "block";
      Object.assign(marco.style, { left: x + "px", top: y + "px", width: w + "px", height: h + "px" });

      // cuatro rectángulos alrededor del hueco: oscurecen y bloquean todo
      // menos el elemento resaltado, que sigue siendo clickeable.
      const W = innerWidth, H = innerHeight;
      const rects = [
        [0, 0, W, Math.max(0, y)],
        [0, y + h, W, Math.max(0, H - (y + h))],
        [0, Math.max(0, y), Math.max(0, x), Math.min(h, H)],
        [x + w, Math.max(0, y), Math.max(0, W - (x + w)), Math.min(h, H)],
      ];
      velos.forEach((v, n) => {
        const [a, b, c, d] = rects[n];
        v.style.cssText = \`position:fixed;background:rgba(15,15,20,.62);pointer-events:auto;left:\${a}px;top:\${b}px;width:\${c}px;height:\${d}px\`;
      });

      // El globo busca dónde ponerse sin tapar lo que está señalando: abajo,
      // arriba, al lado derecho o al izquierdo, en ese orden. Antes iba siempre
      // abajo o arriba, y con elementos altos —el menú de la izquierda— terminaba
      // encima de ellos.
      g.classList.remove("centro");
      const gw = 330, gh = g.offsetHeight || 190, sep = 14, m = 12;
      const cabe = {
        abajo:     H - (y + h) - sep - m >= gh,
        arriba:    y - sep - m >= gh,
        derecha:   W - (x + w) - sep - m >= gw,
        izquierda: x - sep - m >= gw,
      };
      const lado = cabe.abajo ? "abajo" : cabe.arriba ? "arriba"
                 : cabe.derecha ? "derecha" : cabe.izquierda ? "izquierda" : "abajo";

      let gl, gt;
      if (lado === "abajo" || lado === "arriba") {
        gl = r.left + r.width / 2 - gw / 2;
        gt = lado === "abajo" ? y + h + sep : y - gh - sep;
      } else {
        gt = r.top + r.height / 2 - gh / 2;
        gl = lado === "derecha" ? x + w + sep : x - gw - sep;
      }
      gl = Math.min(Math.max(m, gl), Math.max(m, W - gw - m));
      gt = Math.min(Math.max(m, gt), Math.max(m, H - gh - m));
      g.style.left = gl + "px"; g.style.top = gt + "px";

      const f = capa.querySelector(".tt-flecha");
      f.style.display = "block";
      if (lado === "abajo" || lado === "arriba") {
        f.style.left = Math.min(Math.max(16, r.left + r.width / 2 - gl - 6), gw - 28) + "px";
        f.style.top = lado === "abajo" ? "-6px" : (gh - 6) + "px";
      } else {
        f.style.top = Math.min(Math.max(16, r.top + r.height / 2 - gt - 6), gh - 28) + "px";
        f.style.left = lado === "derecha" ? "-6px" : (gw - 6) + "px";
      }

      // avanzar cuando la persona hace clic en el elemento resaltado
      if (alLimpiar) { alLimpiar(); alLimpiar = null; }
      if (paso.alHacerClic) {
        const mano = () => { obj.removeEventListener("click", mano); alLimpiar = null; setTimeout(() => ir(1), 220); };
        obj.addEventListener("click", mano);
        alLimpiar = () => obj.removeEventListener("click", mano);
      }
    }

    this.arrancar = function () {
      estilos();
      // Se saltan los pasos cuyo elemento no existe para esta persona. Los que
      // viven en otra pestaña (\`alEntrar\`) no se pueden comprobar todavía, así
      // que se dejan pasar: si al llegar tampoco están, \`pintar\` los muestra
      // centrados en vez de apuntar al vacío.
      activos = pasos.filter(p => !p.sel || p.alEntrar || buscar(p));
      if (!activos.length) return;
      i = 0;

      capa = document.createElement("div");
      capa.className = "tt-capa";
      capa.innerHTML = \`
        <div class="tt-velo"></div><div class="tt-velo"></div>
        <div class="tt-velo"></div><div class="tt-velo"></div>
        <div class="tt-marco"></div>
        <div class="tt-globo">
          <div class="tt-flecha"></div>
          <button class="tt-salir" title="Cerrar">&times;</button>
          <div class="tt-paso"></div>
          <div class="tt-titulo"></div>
          <div class="tt-texto"></div>
          <div class="tt-pista"></div>
          <div class="tt-pie">
            <div class="tt-puntos"></div>
            <button class="tt-btn s tt-atras">Atrás</button>
            <button class="tt-btn p tt-sig">Siguiente</button>
          </div>
        </div>\`;
      document.body.appendChild(capa);

      capa.querySelector(".tt-salir").onclick = () => cerrar(false);
      capa.querySelector(".tt-atras").onclick = () => ir(-1);
      capa.querySelector(".tt-sig").onclick = () => ir(1);
      window.addEventListener("resize", pintar);
      window.addEventListener("scroll", pintar, true);
      document.addEventListener("keydown", teclas);

      setTimeout(pintar, Math.max(30, acercar(buscar(activos[0]))));
    };
  }

  // ── Persistencia ──────────────────────────────────────────────────────────
  async function rpc(fn, cuerpo) {
    const r = await fetch(RPC + fn, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cuerpo || {}),
    });
    if (!r.ok) throw new Error(fn + " " + r.status);
    return r.json();
  }

  function esperarPantallaLista(sel, tope) {
    if (!sel) return Promise.resolve();
    const oculto = () => {
      const e = document.querySelector(sel);
      return !e || !(e.offsetParent || e.getClientRects().length);
    };
    if (oculto()) return Promise.resolve();
    return new Promise(listo => {
      const t0 = Date.now();
      const reloj = setInterval(() => {
        if (oculto() || Date.now() - t0 > tope) { clearInterval(reloj); listo(); }
      }, 250);
    });
  }

  function marcarVisto(nombre) {
    if (window.TREI_TOUR_DEMO) return;               // en la demo no se guarda nada
    rpc("tour_marcar", { p_tour: nombre }).catch(() => {});
  }

  // ── Arranque ──────────────────────────────────────────────────────────────
  // Se expone para poder relanzarlo desde el botón de ayuda.
  window.TreiTour = {
    lanzar(nombre, pasos) { new Tour(nombre, pasos).arrancar(); },

    // \`anclaje\` es el selector de la zona de arriba a la derecha donde meterlo
    // (en el informe, la línea de "Datos al … · Usuario: …"). Si no existe,
    // el botón queda flotando en la misma esquina.
    botonAyuda(nombre, pasos, opciones) {
      const o = opciones || {};
      estilos();
      const poner = () => {
        if (document.querySelector(".tt-ayuda")) return;
        const b = document.createElement("button");
        b.className = "tt-ayuda";
        b.innerHTML = '<i>?</i>Guía';
        b.title = "Ver de nuevo la guía de esta pantalla";
        b.onclick = () => new Tour(nombre, pasos).arrancar();
        const ancla = o.anclaje ? document.querySelector(o.anclaje) : null;
        if (ancla) { b.classList.add("en-linea"); ancla.appendChild(b); }
        else { b.classList.add("flotante"); document.body.appendChild(b); }
      };
      poner();
      // El informe repinta su cabecera cuando cambian los datos. Si en una de
      // esas se lleva el botón por delante, lo reponemos.
      setInterval(poner, 3000);
    },

    async iniciar(nombre, pasos, opciones) {
      const o = opciones || {};
      this.botonAyuda(nombre, pasos, o);
      if (window.TREI_TOUR_DEMO) return;              // la demo lo lanza a mano
      try {
        const est = await rpc("tour_estado", { p_tour: nombre });
        if (!est || !est.mostrar) return;
        // El informe tarda en cargar sus datos. Si arrancamos antes, el tour
        // apunta a elementos que todavía no existen. Esperamos a que la
        // pantalla de carga desaparezca (con tope, por si nunca lo hace).
        await esperarPantallaLista(o.esperarQueDesaparezca, o.tope || 20000);
        setTimeout(() => new Tour(nombre, pasos).arrancar(), o.espera || 600);
      } catch (_) { /* si la base no responde, no molestamos a nadie */ }
    },
  };
})();
/* ── Pasos del tour del INFORME COMERCIAL ────────────────────────────────────
   Enfoque: entender lo general. Gestión Ventas se muestra una sola vez, sin
   detenerse en cada vista, y el peso del tour se va a Proyectos.

   Selectores reales del informe (verificados en vivo el 04-08-2026):
     #tabs .tab        → GESTIÓN VENTAS · PROYECTOS · REPORTES
     .res-sidebar      → el menú "Vista" de Gestión Ventas
     #proy-side .pitem → la lista de proyectos
     #pcats .pcat      → las seis vistas de cada proyecto
   Si un elemento no existe para esa persona, el paso se salta solo.          */

const irAPestana = nombre => () => {
  const t = [...document.querySelectorAll('#tabs .tab')]
    .find(x => x.textContent.trim().toUpperCase().startsWith(nombre));
  if (t) t.click();
};

const PASOS_INFORME = [

  { titulo: "Bienvenido al Informe Comercial",
    texto_: "Un minuto para ubicarte. Puedes salir cuando quieras con la X o la tecla Esc, y volver a verlo con el botón «Guía» de arriba a la derecha." },

  { sel: "#tabs", alEntrar: irAPestana("GESTIÓN"),
    titulo: "Todo se divide en tres",
    texto_: "Gestión Ventas es la mirada del mes, con todos los proyectos sumados. Proyectos es la ficha de cada uno por separado. Reportes son las descargas." },

  { sel: ".res-sidebar", alEntrar: irAPestana("GESTIÓN"),
    titulo: "Gestión Ventas: la foto del mes",
    texto_: "Este menú cambia lo que ves a la derecha. Cada vista responde una pregunta distinta del mes: qué se prometió, qué se escrituró, qué se proyecta cerrar, qué se desistió." },

  { sel: "#tabs .tab", texto: "PROYECTOS", alEntrar: irAPestana("GESTIÓN"),
    titulo: "Ahora veamos un proyecto",
    texto_: "Gestión Ventas te dice cómo va el mes en total. Cuando necesitas entrar a un proyecto en particular, es en esta pestaña.",
    alHacerClic: "Haz clic en PROYECTOS" },

  { sel: "#proy-side", alEntrar: irAPestana("PROYECTOS"), esperaAlEntrar: 900,
    titulo: "Primero eliges el proyecto",
    texto_: "Acá aparecen los proyectos a los que tienes acceso. Todo lo que veas a la derecha corresponde solo al que esté marcado." },

  { sel: "#pcats", alEntrar: irAPestana("PROYECTOS"),
    titulo: "Y luego, cómo quieres mirarlo",
    texto_: "Seis vistas del mismo proyecto. Ventas Totales es el resumen por estado; Scanner de Precios es la más visual: el edificio piso por piso, con el precio de cada unidad y un color según si está disponible, reservada, promesada o escriturada.",
    alHacerClic: "Prueba: cambia de vista acá arriba" },
];

/* ── Pasos del PORTAL de entrada ──────────────────────────────────────────── */
const PASOS_PORTAL = [
  { titulo: "Este es el portal de informes",
    texto_: "Entraste con tu cuenta de Microsoft, la misma del correo. No hay una contraseña aparte que recordar." },
  { sel: ".cards", titulo: "Elige a dónde entrar",
    texto_: "Informe Comercial tiene ventas, leads y estado comercial. Etapas de Escrituración sigue a cada cliente hasta la inscripción en el Conservador.",
    alHacerClic: "Haz clic en la tarjeta que quieras abrir" },
];

/* ── Arranque ────────────────────────────────────────────────────────────────
   El mismo archivo sirve para las dos pantallas; decide cuál es por lo que
   encuentra en el DOM. */
if (document.getElementById("tabs") && document.getElementById("app")) {
  TreiTour.iniciar("informe", PASOS_INFORME, {
    anclaje: ".top-header .meta",
    esperarQueDesaparezca: "#loading",   // el informe tarda en traer sus datos
  });
} else if (document.querySelector(".kpi-card")) {
  TreiTour.iniciar("portal", PASOS_PORTAL, { anclaje: ".top-header .meta" });
}
`;

const ETIQUETA_TOUR = '<script src="/informe_ventas/tour.js" defer></script>';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/informe_ventas/auth/callback") {
      return handleCallback(request, env, url);
    }

    if (url.pathname === "/informe_ventas/auth/logout") {
      return new Response(null, {
        status: 302,
        headers: {
          "Location": "/informe_ventas/",
          "Set-Cookie": `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`,
        },
      });
    }

    const session = await getSession(request, env);
    if (!session) return redirectToLogin(url, env);

    const permitido = await puedeEntrar(session.email, env);
    if (!permitido) return respuestaSinAcceso(session.email);

    // El informe ya no lleva la anon key: sus consultas pasan por acá y el
    // worker les pone las credenciales, firmadas con el correo de la sesión.
    if (url.pathname.startsWith("/informe_ventas/db/")) {
      return proxySupabase(request, env, url, session.email);
    }

    if (url.pathname === "/informe_ventas/tour.js") {
      return new Response(TOUR_JS, {
        headers: {
          "Content-Type": "application/javascript; charset=utf-8",
          "Cache-Control": "public, max-age=300",
        },
      });
    }

    // Portal de informes: se muestra al entrar a la raíz. El botón "Entrar"
    // agrega ?ir=1 para saltárselo y pasar directo al informe.
    const isEntryPoint = url.pathname === "/informe_ventas/" || url.pathname === "/informe_ventas";
    if (isEntryPoint && !url.searchParams.has("ir")) {
      return await renderHub(session, env);
    }
    if (url.searchParams.has("ir")) {
      url.searchParams.delete("ir");
    }

    return proxyToOrigin(request, env, url);
  },
};

// ════════════════════════════════════════════════════════════════════════════
// QUIÉN PUEDE ENTRAR
// ════════════════════════════════════════════════════════════════════════════

// Dominio permitido O padrón del informe. Se consulta el padrón solo cuando el
// correo no es del dominio, así la gente de casa no paga la latencia extra.
// Si Supabase no responde, se cae al comportamiento anterior (solo dominio):
// preferimos dejar fuera a un externo antes que dejar el portal abierto.
async function puedeEntrar(email, env) {
  const correo = String(email || "").toLowerCase();
  if (!correo) return false;

  const dominio = (env.ALLOWED_DOMAIN || "").toLowerCase();
  if (dominio && correo.endsWith("@" + dominio)) return true;

  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return false;

  try {
    const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/informe_puede_entrar`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: env.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${env.SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({ p_email: correo }),
    });
    if (!res.ok) return false;
    return (await res.json()) === true;
  } catch (_) {
    return false;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// PUENTE A SUPABASE
// El navegador nunca ve una llave. Pide a /informe_ventas/db/rest/v1/... y el
// worker reenvía a Supabase firmando un token de 5 minutos con el correo que
// Entra ya validó. La base decide qué filas devuelve según ese correo.
// ════════════════════════════════════════════════════════════════════════════

async function proxySupabase(request, env, url, email) {
  if (!env.SUPABASE_URL || !env.SUPABASE_JWT_SECRET || !env.SUPABASE_ANON_KEY) {
    return new Response("Falta configurar SUPABASE_URL, SUPABASE_ANON_KEY o SUPABASE_JWT_SECRET.", { status: 500 });
  }

  const ruta = url.pathname.replace("/informe_ventas/db", "");
  if (!ruta.startsWith("/rest/v1/")) return new Response("Ruta no permitida.", { status: 403 });

  const now = Math.floor(Date.now() / 1000);
  const token = await firmarJwtHS256({
    aud: "authenticated",
    role: "authenticated",
    sub: await uuidDesdeEmail(email),
    email: String(email).toLowerCase(),
    iat: now,
    exp: now + 300,
  }, env.SUPABASE_JWT_SECRET);

  // Se copian solo las cabeceras que PostgREST necesita; nunca las que venga
  // intentando poner el navegador (apikey o Authorization propias).
  const headers = new Headers();
  for (const h of ["content-type", "prefer", "range", "accept", "accept-profile", "content-profile"]) {
    const v = request.headers.get(h);
    if (v) headers.set(h, v);
  }
  headers.set("apikey", env.SUPABASE_ANON_KEY);
  headers.set("Authorization", "Bearer " + token);

  const destino = env.SUPABASE_URL + ruta + url.search;
  const res = await fetch(destino, {
    method: request.method,
    headers,
    body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.text(),
  });

  const salida = new Response(res.body, res);
  salida.headers.set("Cache-Control", "no-store");
  salida.headers.delete("set-cookie");
  return salida;
}

async function firmarJwtHS256(payload, secret) {
  const b64 = (obj) => b64url(new TextEncoder().encode(JSON.stringify(obj)));
  const cuerpo = b64({ alg: "HS256", typ: "JWT" }) + "." + b64(payload);
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const firma = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(cuerpo));
  return cuerpo + "." + b64url(new Uint8Array(firma));
}

function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function uuidDesdeEmail(email) {
  const h = new Uint8Array(await crypto.subtle.digest(
    "SHA-256", new TextEncoder().encode("trei-informe:" + String(email).toLowerCase())));
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = [...h.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

function respuestaSinAcceso(email) {
  return new Response(
    `Sin acceso al Informe Comercial.\n\n` +
    `La cuenta ${email} no pertenece al dominio autorizado y no está registrada ` +
    `en el padrón del informe (o su acceso venció).\n\n` +
    `Para solicitarlo, escribe a Control de Gestión indicando este correo.`,
    { status: 403, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

// ════════════════════════════════════════════════════════════════════════════
// AUTENTICACIÓN
// ════════════════════════════════════════════════════════════════════════════

function redirectToLogin(url, env) {
  const redirectUri = `${url.origin}/informe_ventas/auth/callback`;
  const state = encodeURIComponent(url.pathname + url.search);
  const authUrl = new URL(`https://login.microsoftonline.com/${env.ENTRA_TENANT_ID}/oauth2/v2.0/authorize`);
  authUrl.searchParams.set("client_id", env.ENTRA_CLIENT_ID);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_mode", "query");
  authUrl.searchParams.set("scope", "openid profile email");
  authUrl.searchParams.set("state", state);
  return Response.redirect(authUrl.toString(), 302);
}

// El UPN de un invitado B2B llega como
//   contralor_estudio.cl#EXT#@treicl.onmicrosoft.com
// y el correo real viene en el claim `email`. Por eso ese va primero.
function correoReal(claims) {
  const directo = claims.email || claims.preferred_username || claims.upn || "";
  if (!directo.includes("#EXT#")) return String(directo).toLowerCase();
  const local = directo.split("#EXT#")[0];
  const corte = local.lastIndexOf("_");
  return (corte === -1 ? local : local.slice(0, corte) + "@" + local.slice(corte + 1)).toLowerCase();
}

// `state` vuelve del callback y se usaba tal cual como Location: un link
// preparado mandaba al usuario fuera del sitio tras un login legítimo.
function destinoSeguro(state, prefijo) {
  let d;
  try { d = decodeURIComponent(state || ""); } catch (_) { return prefijo; }
  return d.startsWith(prefijo) && !d.startsWith("//") ? d : prefijo;
}

async function handleCallback(request, env, url) {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state") || "/informe_ventas/";
  if (!code) return new Response("Falta el parámetro 'code' en el callback.", { status: 400 });

  const redirectUri = `${url.origin}/informe_ventas/auth/callback`;
  const tokenRes = await fetch(`https://login.microsoftonline.com/${env.ENTRA_TENANT_ID}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.ENTRA_CLIENT_ID,
      client_secret: env.ENTRA_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }),
  });

  if (!tokenRes.ok) return new Response("Error al obtener el token: " + await tokenRes.text(), { status: 502 });

  const tokenData = await tokenRes.json();
  const claims = await verifyIdToken(tokenData.id_token, env);
  if (!claims) return new Response("Token de Entra ID inválido.", { status: 401 });

  const email = correoReal(claims);
  const sessionCookie = await createSessionCookie({ email, name: claims.name }, env);

  return new Response(null, {
    status: 302,
    headers: {
      "Location": destinoSeguro(state, "/informe_ventas/"),
      "Set-Cookie": sessionCookie,
    },
  });
}

async function verifyIdToken(idToken, env) {
  const [headerB64, payloadB64, sigB64] = idToken.split(".");
  const header = JSON.parse(base64UrlDecode(headerB64));
  const payload = JSON.parse(base64UrlDecode(payloadB64));

  if (payload.aud !== env.ENTRA_CLIENT_ID) return null;
  if (payload.tid !== env.ENTRA_TENANT_ID) return null;
  if (payload.exp * 1000 < Date.now()) return null;
  if (payload.iss && !payload.iss.includes(env.ENTRA_TENANT_ID)) return null;

  const jwks = await fetch(`https://login.microsoftonline.com/${env.ENTRA_TENANT_ID}/discovery/v2.0/keys`).then(r => r.json());
  const jwk = jwks.keys.find(k => k.kid === header.kid);
  if (!jwk) return null;

  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, base64UrlToBytes(sigB64), data);
  return valid ? payload : null;
}

async function createSessionCookie(data, env) {
  const payload = { ...data, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS };
  const payloadStr = base64UrlEncode(JSON.stringify(payload));
  const sig = await hmacSign(payloadStr, env.SESSION_SECRET);
  const secureFlag = env.ENVIRONMENT === "development" ? "" : "; Secure";
  return `${COOKIE_NAME}=${payloadStr}.${sig}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}${secureFlag}`;
}

async function getSession(request, env) {
  const cookieHeader = request.headers.get("Cookie") || "";
  const match = cookieHeader.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
  if (!match) return null;
  const [payloadStr, sig] = match[1].split(".");
  if (!payloadStr || !sig) return null;
  if (sig !== await hmacSign(payloadStr, env.SESSION_SECRET)) return null;
  const payload = JSON.parse(base64UrlDecode(payloadStr));
  if (payload.exp * 1000 < Date.now()) return null;
  return payload;
}

async function hmacSign(message, secret) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return base64UrlEncode(String.fromCharCode(...new Uint8Array(sig)));
}

async function proxyToOrigin(request, env, url) {
  // En el directorio del informe quedó un index antiguo (la pantalla de clave
  // anterior a Entra) que el servidor entrega antes que index.html. Pidiendo
  // el archivo explícitamente se evita esa precedencia, sin tocar el servidor.
  const ruta = url.pathname.endsWith("/") ? url.pathname + "index.html" : url.pathname;
  const originUrl = new URL(ruta + url.search, env.ORIGIN_BASE_URL);

  // Sin cacheTtl:0, Cloudflare guarda el HTML del informe en el borde y sigue
  // sirviendo una versión vieja después de cada publicación. Pasó: la URL con
  // ?ir=1 quedó devolviendo la pantalla de acceso anterior durante horas.
  const originResp = await fetch(originUrl.toString(), {
    method: request.method,
    headers: request.headers,
    cf: { cacheTtl: 0, cacheEverything: false },
  });

  let resp = new Response(originResp.body, originResp);
  resp.headers.set("X-Robots-Tag", "noindex, nofollow");
  resp.headers.set("Cache-Control", "no-store, must-revalidate");

  // Se le cuelga el tour al final del <body>. HTMLRewriter va leyendo el HTML
  // a medida que pasa, así que no importa que el informe pese 500 KB.
  const tipo = resp.headers.get("content-type") || "";
  if (tipo.includes("text/html")) {
    resp = new HTMLRewriter()
      .on("body", { element(e) { e.append(ETIQUETA_TOUR, { html: true }); } })
      .transform(resp);
  }
  return resp;
}

function base64UrlEncode(str) { return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function base64UrlDecode(str) { str = str.replace(/-/g, "+").replace(/_/g, "/"); while (str.length % 4) str += "="; return atob(str); }
function base64UrlToBytes(str) { const bin = base64UrlDecode(str); const b = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i); return b; }

// ════════════════════════════════════════════════════════════════════════════
// PORTAL DE INFORMES
// ════════════════════════════════════════════════════════════════════════════

async function renderHub(session, env) {
  const name = session.name || session.email || "";
  const email = String(session.email || "").toLowerCase();
  const bypass = (env.BYPASS_MANTENCION || "")
    .split(",").map(e => e.trim().toLowerCase()).filter(Boolean)
    .includes(email);

  const maintenance = await estadoMantencion(env);

  return new Response(hubHtml({
    name,
    email,
    allowedDomain: env.ALLOWED_DOMAIN || "",
    comercialMaint: bypass ? false : !!maintenance.comercial,
    escrituracionMaint: bypass ? false : !!maintenance.escrituracion,
  }), { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

function escapeHtml(str) {
  return String(str || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

function cardHtml({ accent, title, desc, href, maint }) {
  if (maint) {
    return `
<div class="kpi-card ${accent} maint">
  <div class="top-row">
    <h3>${escapeHtml(title)}</h3>
    <span class="badge b-maint">En mantención</span>
  </div>
  <p class="desc">${escapeHtml(desc)}</p>
  <div class="go">No disponible</div>
  <div class="maint-note">Estamos actualizando este informe. Vuelve a intentarlo en unos minutos.</div>
</div>`;
  }
  return `
<a class="kpi-card ${accent}" href="${href}">
  <div class="top-row">
    <h3>${escapeHtml(title)}</h3>
    <span class="badge b-ok">Disponible</span>
  </div>
  <p class="desc">${escapeHtml(desc)}</p>
  <div class="go">Entrar <span class="arrow">→</span></div>
</a>`;
}

function hubHtml({ name, email, allowedDomain, comercialMaint, escrituracionMaint }) {
  const cardComercial = cardHtml({
    accent: "c-red",
    title: "Informe Comercial",
    desc: "Ventas, leads y estado comercial en tiempo real.",
    href: "/informe_ventas/?ir=1",
    maint: comercialMaint,
  });
  const cardEscrituracion = cardHtml({
    accent: "c-navy",
    title: "Informe de Etapas de Escrituración",
    desc: "Seguimiento del proceso de escrituración por cliente.",
    href: ESCRITURACION_URL,
    maint: escrituracionMaint,
  });

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Portal de Informes — Trei</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Ubuntu:wght@400;500;700&display=swap" rel="stylesheet">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: 'Ubuntu', Calibri, sans-serif; background: #f7f7f8; color: #111111; font-size: 13px; }
.top-header { background: #fff; color: #111111; padding: 6px 28px; display: flex; justify-content: space-between; align-items: center; position: sticky; top: 0; z-index: 100; border-bottom: 2px solid #E1093F; }
.top-header .brand { display: flex; align-items: center; gap: 10px; }
.logo-mark { display:flex; align-items:center; gap:8px; }
.logo-mark .bracket { width:22px; height:22px; border:2.5px solid #E1093F; border-right:none; border-top:none; border-radius:0 0 0 3px; }
.logo-mark .word { line-height:1; }
.logo-mark .word b { font-size:15px; font-weight:700; color:#333; }
.logo-mark .word .sub { display:block; font-size:6px; letter-spacing:1.2px; color:#999; font-weight:700; }
.top-header h1 { font-size: 12px; font-weight: 700; letter-spacing: 0.5px; color: #111111; text-transform: uppercase; padding-left:14px; margin-left:14px; border-left:1px solid #e4e4e8; }
.top-header h1 span { color: #E1093F; }
.top-header .meta { font-size: 10px; color: #888; text-align: right; line-height: 1.4; display:flex; align-items:center; gap:10px; }
.top-header .meta strong { color: #111111; }
.top-header .msft { width:14px; height:14px; flex-shrink:0; }
.top-header .logout { color:#aaa; text-decoration:underline; }
.tabs-bar { background:#111111; padding:7px 28px; font-size:10px; color:#999; letter-spacing:.5px; }
.tabs-bar b { color:#fff; }
.content { padding: 28px 24px 60px; max-width: 1120px; margin: 0 auto; }
.section-title { font-size: 10px; font-weight: 700; letter-spacing: 1.4px; text-transform: uppercase; color: #E1093F; margin-bottom: 4px; }
.section-sub { font-size: 12px; color: #888; margin-bottom: 20px; }
.cards { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
@media (max-width:640px){.cards{grid-template-columns:1fr}}
.kpi-card { background:#fff; border:1.5px solid #e4e4e8; border-radius:8px; padding:22px 20px; position:relative; overflow:hidden; display:flex; flex-direction:column; gap:10px; text-decoration:none; color:inherit; transition: box-shadow .15s, border-color .15s; }
.kpi-card::before { content:''; position:absolute; left:0; top:0; bottom:0; width:4px; }
.kpi-card.c-red::before { background:#E1093F; }
.kpi-card.c-navy::before { background:#111111; }
.kpi-card:not(.maint):hover { box-shadow:0 4px 14px rgba(0,0,0,.08); border-color:#d8d8de; cursor:pointer; }
.kpi-card .top-row { display:flex; justify-content:space-between; align-items:flex-start; }
.kpi-card h3 { font-size:14.5px; font-weight:700; color:#111; }
.kpi-card p.desc { font-size:11.5px; color:#888; margin-top:2px; }
.kpi-card .go { font-size:11px; font-weight:700; color:#E1093F; text-transform:uppercase; letter-spacing:.4px; margin-top:auto; padding-top:6px; }
.badge { display:inline-block; font-size:10px; font-weight:700; border-radius:4px; padding:2px 8px; }
.b-ok { background:#e6f2eb; color:#006400; }
.b-maint { background:#fff0dc; color:#b07800; }
.kpi-card.maint::before { background:#e0a734; }
.kpi-card.maint h3, .kpi-card.maint p.desc { color:#a8a8ae; }
.kpi-card.maint .go { color:#c9c9d1; }
.maint-note { font-size:11px; color:#b07800; background:#fff0dc; border-radius:5px; padding:5px 8px; }
</style>
</head>
<body>

<div class="top-header">
  <div class="brand">
    <div class="logo-mark">
      <div class="bracket"></div>
      <div class="word"><b>trei</b><span class="sub">INMOBILIARIA</span></div>
    </div>
    <h1>Portal de <span>Informes</span></h1>
  </div>
  <div class="meta">
    <svg class="msft" width="14" height="14" viewBox="0 0 15 15"><rect width="7" height="7" fill="#F25022"/><rect x="8" width="7" height="7" fill="#7FBA00"/><rect y="8" width="7" height="7" fill="#00A4EF"/><rect x="8" y="8" width="7" height="7" fill="#FFB900"/></svg>
    <div><strong>${escapeHtml(name)}</strong><br>${escapeHtml(email)}</div>
    <a class="logout" href="/informe_ventas/auth/logout">Salir</a>
  </div>
</div>

<div class="tabs-bar"><b>Sesión validada</b> · Microsoft Entra ID${allowedDomain ? " — dominio " + escapeHtml(allowedDomain) : ""}</div>

<div class="content">
  <div class="section-title">Acceso a informes</div>
  <div class="section-sub">Elige el informe al que quieres entrar.</div>
  <div class="cards">
    ${cardComercial}
    ${cardEscrituracion}
  </div>
</div>

${ETIQUETA_TOUR}
</body>
</html>`;
}
