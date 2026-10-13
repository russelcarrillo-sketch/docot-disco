// Función de Vercel: crea el pago de Mercado Pago de forma segura.
// Valida los precios reales desde Firestore (el cliente no puede alterarlos),
// calcula el envío según la configuración del admin y guarda el pedido.

import { createHash, randomBytes } from 'node:crypto';

// Códigos de descuento. Esta tabla es la que manda: el navegador solo manda el
// código, aquí se valida y se recalcula el precio real que cobra Mercado Pago.
// (Hay una copia para la vista previa en catalogo.html — actualiza ambas.)
// unaVezPorPersona: el mismo correo no puede volver a usarlo.
const CUPONES = {
  BIENVENIDO10: { pct: 10, unaVezPorPersona: true },
};

// Identificador anónimo de "este correo ya usó este código".
// Es un hash: no guardamos el correo en ningún lado.
function cuponHash(codigo, correo) {
  return createHash('sha256')
    .update(codigo + '|' + String(correo).trim().toLowerCase())
    .digest('hex')
    .slice(0, 40);
}

const PROJECT = 'peces-disco';
const API_KEY = 'AIzaSyA0C0UR6-R4S_Cp86yEEfj1COLkY5oFPn4';
const FS_BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

function parseFs(v) {
  if (v == null) return null;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.integerValue !== undefined) return parseInt(v.integerValue, 10);
  if (v.doubleValue !== undefined) return parseFloat(v.doubleValue);
  if (v.booleanValue !== undefined) return v.booleanValue;
  if (v.nullValue !== undefined) return null;
  if (v.arrayValue) return (v.arrayValue.values || []).map(parseFs);
  if (v.mapValue) {
    const r = {};
    const f = v.mapValue.fields || {};
    Object.keys(f).forEach((k) => { r[k] = parseFs(f[k]); });
    return r;
  }
  return null;
}

function fsv(v) {
  if (typeof v === 'number') {
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  return { stringValue: String(v == null ? '' : v) };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Método no permitido' });
    return;
  }
  const token = process.env.MP_ACCESS_TOKEN;
  if (!token) {
    res.status(500).json({ error: 'Falta configurar MP_ACCESS_TOKEN en Vercel' });
    return;
  }
  try {
    const { items, envio, envioTipo, cupon } = req.body || {};
    if (!Array.isArray(items) || !items.length) {
      res.status(400).json({ error: 'El carrito está vacío' });
      return;
    }
    const requeridos = ['nombre', 'telefono', 'correo', 'direccion', 'colonia', 'ciudad', 'estado', 'cp'];
    for (const c of requeridos) {
      if (!envio || !String(envio[c] || '').trim()) {
        res.status(400).json({ error: 'Faltan datos de envío' });
        return;
      }
    }

    // Precios y configuración de envío reales desde Firestore
    const fsRes = await fetch(`${FS_BASE}/negocio/hygger?key=${API_KEY}`);
    const fsData = await fsRes.json();
    if (!fsData.fields) throw new Error('No se pudo leer el catálogo');
    const hyg = {};
    Object.keys(fsData.fields).forEach((k) => { hyg[k] = parseFs(fsData.fields[k]); });
    const prods = hyg.productos || [];

    let subtotal = 0;
    const mpItems = [];
    const detalle = [];
    for (const it of items) {
      const p = prods.find((x) => x.id === it.id);
      const v = p && (p.variantes || [])[it.varIdx];
      const qty = Math.max(1, Math.min(20, parseInt(it.cantidad, 10) || 1));
      if (!p || !v || !(v.precio > 0)) {
        res.status(400).json({ error: 'Un producto del carrito ya no está disponible. Recarga la página.' });
        return;
      }
      subtotal += v.precio * qty;
      const titulo = `${p.nombre}${v.desc ? ' — ' + v.desc : ''}`.slice(0, 120);
      mpItems.push({ title: titulo, quantity: qty, unit_price: Number(v.precio), currency_id: 'MXN' });
      detalle.push({ nombre: titulo, cantidad: qty, precio: Number(v.precio) });
    }

    // Descuento: se valida aquí contra la tabla del servidor, nunca se confía en el navegador
    const codigo = String(cupon || '').trim().toUpperCase();
    let cup = CUPONES[codigo] || null;
    let hashCupon = '';
    if (cup && cup.unaVezPorPersona) {
      hashCupon = cuponHash(codigo, envio.correo);
      try {
        const usoRes = await fetch(`${FS_BASE}/cupones_usados/${hashCupon}?key=${API_KEY}`);
        if (usoRes.ok) {
          res.status(400).json({
            error: `El código ${codigo} ya fue usado con el correo ${envio.correo}. Es válido una sola vez por persona.`,
            cuponUsado: true,
          });
          return;
        }
      } catch (e) {
        // Si no se puede verificar, se deja pasar el descuento antes que bloquear la venta
      }
    }
    const descuento = cup ? Math.round(subtotal * cup.pct) / 100 : 0;
    const cuponAplicado = cup ? codigo : '';
    if (descuento > 0) {
      // Mercado Pago no acepta importes negativos: el descuento se reparte entre los productos
      const objetivo = Math.round((subtotal - descuento) * 100) / 100;
      const factor = objetivo / subtotal;
      let suma = 0;
      mpItems.forEach((it) => {
        it.unit_price = Math.round(it.unit_price * factor * 100) / 100;
        suma = Math.round((suma + it.unit_price * it.quantity) * 100) / 100;
      });
      // Los centavos que sobren por el redondeo se ajustan en el último producto
      const dif = Math.round((objetivo - suma) * 100) / 100;
      if (dif !== 0 && mpItems.length) {
        const last = mpItems[mpItems.length - 1];
        last.unit_price = Math.round((last.unit_price + dif / last.quantity) * 100) / 100;
      }
      mpItems.push({
        title: `Descuento ${codigo} (-${cup.pct}%) ya aplicado`,
        quantity: 1,
        unit_price: 0,
        currency_id: 'MXN',
      });
    }

    // Envío: terrestre (puede ser gratis) o aéreo. El costo se calcula aquí, no se confía en el cliente.
    // El envío gratis se mide sobre el subtotal ANTES del descuento.
    const envioGratisDesde = Number(hyg.envioGratisDesde) || 0;
    const aplicaGratis = envioGratisDesde > 0 && subtotal >= envioGratisDesde;
    const costoAereo = Number(hyg.envioAereo) || 0;
    const tipo = envioTipo === 'aereo' && costoAereo > 0 ? 'aereo' : 'terrestre';
    const diasT = String(hyg.envioDiasT || '4 a 7').trim();
    const diasA = String(hyg.envioDiasA || '2 a 3').trim();
    const costoEnvio =
      tipo === 'aereo' ? costoAereo : aplicaGratis ? 0 : Number(hyg.envioCosto) || 0;
    const envioNombre =
      tipo === 'aereo' ? `Envío aéreo (${diasA} días hábiles)` : `Envío terrestre (${diasT} días hábiles)`;
    if (costoEnvio > 0) {
      mpItems.push({ title: envioNombre, quantity: 1, unit_price: costoEnvio, currency_id: 'MXN' });
    }
    const total = Math.round((subtotal - descuento + costoEnvio) * 100) / 100;

    // Guardar el pedido (colección "pedidos", solo-crear)
    const orderId = 'PED-' + Date.now().toString(36).toUpperCase();
    // Secreto del pedido: viaja en los metadatos de Mercado Pago y permite que el
    // webhook actualice este pedido. Nadie más puede leerlo (las reglas bloquean la lectura).
    const secreto = randomBytes(16).toString('hex');
    const orderFields = {
      secreto: fsv(secreto),
      fecha: fsv(new Date().toISOString()),
      status: fsv('pendiente_pago'),
      nombre: fsv(envio.nombre),
      telefono: fsv(envio.telefono),
      correo: fsv(envio.correo || ''),
      direccion: fsv(envio.direccion),
      colonia: fsv(envio.colonia),
      ciudad: fsv(envio.ciudad),
      estado: fsv(envio.estado),
      cp: fsv(envio.cp),
      referencias: fsv(envio.referencias || ''),
      items: fsv(JSON.stringify(detalle)),
      subtotal: fsv(subtotal),
      cupon: fsv(cuponAplicado),
      descuento: fsv(descuento),
      envio: fsv(costoEnvio),
      envioTipo: fsv(tipo),
      envioNombre: fsv(envioNombre),
      total: fsv(total),
    };
    await fetch(`${FS_BASE}/pedidos?documentId=${orderId}&key=${API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: orderFields }),
    });

    // El cupón NO se marca aquí: lo marca el webhook cuando Mercado Pago
    // confirma el pago, para que nadie pierda su descuento si abandona el carrito.

    // Crear preferencia de Mercado Pago
    const base = `https://${req.headers.host}`;
    const prefRes = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: mpItems,
        external_reference: orderId,
        payer: { name: envio.nombre, email: envio.correo || undefined },
        back_urls: {
          success: `${base}/catalogo.html?pago=exito&pedido=${orderId}`,
          pending: `${base}/catalogo.html?pago=pendiente&pedido=${orderId}`,
          failure: `${base}/catalogo.html?pago=error`,
        },
        auto_return: 'approved',
        statement_descriptor: 'DOCTORDISCO',
        notification_url: `${base}/api/webhook-mp`,
        metadata: {
          pedido: orderId,
          secreto,
          cupon: cuponAplicado,
          cupon_hash: hashCupon,
        },
      }),
    });
    const pref = await prefRes.json();
    if (!pref.init_point) {
      res.status(500).json({ error: 'Mercado Pago: ' + (pref.message || 'no se pudo crear el pago') });
      return;
    }
    res.status(200).json({ url: pref.init_point, pedido: orderId, total });
  } catch (e) {
    res.status(500).json({ error: 'Error interno: ' + e.message });
  }
}
