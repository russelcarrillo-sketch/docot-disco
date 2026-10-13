// Webhook de Mercado Pago.
//
// Mercado Pago avisa aquí cada vez que cambia un pago. Nunca confiamos en lo que
// llega: solo tomamos el ID y le preguntamos a Mercado Pago el estado real usando
// nuestro MP_ACCESS_TOKEN.
//
// Cuando un pago queda "approved":
//   1. Marca el cupón como usado (hasta ahora el cliente no lo había gastado).
//   2. Pone el pedido en "pagado".
//
// Es idempotente: si Mercado Pago llama varias veces con el mismo pago, no pasa nada.

const PROJECT = 'peces-disco';
const API_KEY = 'AIzaSyA0C0UR6-R4S_Cp86yEEfj1COLkY5oFPn4';
const FS_BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

function fsv(v) {
  if (typeof v === 'number') {
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  return { stringValue: String(v == null ? '' : v) };
}

// Del estado de Mercado Pago al estado que mostramos en el panel
function estadoPedido(status) {
  if (status === 'approved') return 'pagado';
  if (status === 'rejected' || status === 'cancelled') return 'rechazado';
  return 'pendiente_pago';
}

// Saca el ID del pago, venga como venga (Mercado Pago usa varios formatos)
function sacarPagoId(req) {
  const q = req.query || {};
  const b = typeof req.body === 'object' && req.body ? req.body : {};
  const tipo = q.type || q.topic || b.type || b.topic || '';
  if (tipo && String(tipo).indexOf('payment') < 0) return null; // ignoramos merchant_order, etc.
  const id =
    q['data.id'] ||
    q.id ||
    (b.data && b.data.id) ||
    b.id ||
    (typeof b.resource === 'string' ? b.resource.split('/').pop() : null);
  return id ? String(id) : null;
}

export default async function handler(req, res) {
  // Mercado Pago valida la URL con un GET
  if (req.method === 'GET') {
    res.status(200).send('ok');
    return;
  }
  if (req.method !== 'POST') {
    res.status(200).send('ok');
    return;
  }

  const token = process.env.MP_ACCESS_TOKEN;
  const pagoId = sacarPagoId(req);

  // Sin ID de pago o sin token no hay nada que hacer: respondemos 200 para que
  // Mercado Pago no reintente en vano.
  if (!pagoId || !token) {
    res.status(200).json({ ok: true, ignorado: true });
    return;
  }

  try {
    // 1. Preguntarle a Mercado Pago el estado real del pago
    const pagoRes = await fetch(`https://api.mercadopago.com/v1/payments/${pagoId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!pagoRes.ok) {
      // 404 = pago de otra cuenta o prueba: no reintentar
      if (pagoRes.status === 404) {
        res.status(200).json({ ok: true, ignorado: true });
        return;
      }
      res.status(500).json({ error: 'No se pudo consultar el pago' });
      return;
    }
    const pago = await pagoRes.json();

    const meta = pago.metadata || {};
    // Mercado Pago a veces devuelve las llaves de metadata en snake_case
    const pedido = meta.pedido || pago.external_reference || '';
    const secreto = meta.secreto || '';
    const cuponHash = meta.cupon_hash || meta.cuponHash || '';
    const cupon = meta.cupon || '';
    const aprobado = pago.status === 'approved';

    // 2. Si se aprobó y traía cupón, ahora sí se marca como usado
    if (aprobado && cuponHash) {
      try {
        await fetch(`${FS_BASE}/cupones_usados?documentId=${cuponHash}&key=${API_KEY}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fields: {
              codigo: fsv(cupon),
              fecha: fsv(new Date().toISOString()),
              pedido: fsv(pedido),
            },
          }),
        });
        // Si ya existía, Firestore responde 409 y lo damos por bueno (idempotente)
      } catch (e) {
        /* no bloquea el resto */
      }
    }

    // 3. Actualizar el estado del pedido (solo campos de pago, con el secreto del pedido)
    if (pedido && secreto) {
      const campos = ['status', 'pagoId', 'pagoEstado', 'pagoFecha', 'pagoMetodo', 'secretoCheck'];
      const mask = campos.map((c) => `updateMask.fieldPaths=${c}`).join('&');
      try {
        await fetch(`${FS_BASE}/pedidos/${pedido}?${mask}&key=${API_KEY}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fields: {
              status: fsv(estadoPedido(pago.status)),
              pagoId: fsv(String(pago.id || pagoId)),
              pagoEstado: fsv(String(pago.status || '')),
              pagoFecha: fsv(pago.date_approved || new Date().toISOString()),
              pagoMetodo: fsv(String(pago.payment_method_id || '')),
              secretoCheck: fsv(secreto),
            },
          }),
        });
      } catch (e) {
        /* no bloquea la respuesta */
      }
    }

    res.status(200).json({ ok: true, pedido, estado: pago.status });
  } catch (e) {
    res.status(500).json({ error: 'Error procesando el aviso' });
  }
}
