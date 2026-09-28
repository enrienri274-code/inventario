const express = require("express");
const mysql = require("mysql2");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const QRCode = require("qrcode");
const PDFDocument = require("pdfkit");
const ExcelJS = require("exceljs");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const app = express();

// =====================================================
// MIDDLEWARES
// =====================================================

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const SECRET = process.env.JWT_SECRET || "clave_secreta_inventario";

// =====================================================
// CARPETAS
// =====================================================

const UPLOADS_DIR = path.join(__dirname, "uploads");
const QRS_DIR = path.join(__dirname, "qrs");

[UPLOADS_DIR, QRS_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

app.use("/uploads", express.static(UPLOADS_DIR));
app.use("/qrs", express.static(QRS_DIR));

// =====================================================
// MULTER
// =====================================================

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOADS_DIR);
  },

  filename: (req, file, cb) => {
    const extension = path.extname(file.originalname);

    cb(
      null,
      `${Date.now()}-${Math.round(Math.random() * 1e9)}${extension}`
    );
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
  fileFilter: (req, file, cb) => {
    const extensionesPermitidas = [
      ".jpg",
      ".jpeg",
      ".png",
      ".webp",
    ];

    const extension = path
      .extname(file.originalname)
      .toLowerCase();

    if (extensionesPermitidas.includes(extension)) {
      cb(null, true);
    } else {
      cb(new Error("Solo se permiten imágenes JPG, JPEG, PNG y WEBP"));
    }
  },
});

// =====================================================
// CONEXIÓN MYSQL - RAILWAY
// =====================================================

// Railway provee automáticamente estas variables cuando vinculas la BD MySQL
const conexion = mysql.createPool({
  host: process.env.MYSQLHOST || process.env.DATABASE_HOST || "localhost",
  port: parseInt(process.env.MYSQLPORT || process.env.DATABASE_PORT || "3306", 10),
  user: process.env.MYSQLUSER || process.env.DATABASE_USER || "root",
  password: process.env.MYSQLPASSWORD || process.env.DATABASE_PASSWORD || "12345",
  database: process.env.MYSQLDATABASE || process.env.DATABASE_NAME || "inventario_db",

  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
});

conexion.getConnection((err, connection) => {
  if (err) {
    console.error("❌ Error de conexión a MySQL en Railway:");
    console.error(err.message);
  } else {
    console.log("✅ Conectado correctamente a MySQL en Railway");
    connection.release();
  }
});

// =====================================================
// RUTA PRINCIPAL
// =====================================================

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    mensaje: "Servidor de Inventario funcionando correctamente en Railway",
  });
});

// =====================================================
// JWT
// =====================================================

function verificarToken(req, res, next) {
  const authHeader = req.headers["authorization"];

  const token =
    authHeader && authHeader.split(" ")[1]
      ? authHeader.split(" ")[1]
      : authHeader;

  if (!token) {
    return res.status(401).json({
      status: "error",
      mensaje: "Token requerido",
    });
  }

  jwt.verify(token, SECRET, (err, decoded) => {
    if (err) {
      return res.status(403).json({
        status: "error",
        mensaje: "Token inválido",
      });
    }

    req.usuario = decoded;
    next();
  });
}

// =====================================================
// DOCENTES
// =====================================================

app.get("/docentes", (req, res) => {
  const sql = `
    SELECT id, nombre, correo, rol
    FROM usuarios
    WHERE rol = 'maestro'
    ORDER BY nombre ASC
  `;

  conexion.query(sql, (err, results) => {
    if (err) {
      return res.status(500).json({
        status: "error",
        mensaje: err.message,
      });
    }

    res.json(results);
  });
});

// =====================================================
// USUARIOS
// =====================================================

app.get("/usuarios", (req, res) => {
  const sql = `
    SELECT id, nombre, correo, rol
    FROM usuarios
    ORDER BY nombre ASC
  `;

  conexion.query(sql, (err, results) => {
    if (err) {
      return res.status(500).json({
        status: "error",
        mensaje: err.message,
      });
    }

    res.json(results);
  });
});

// =====================================================
// PRESTAMOS
// =====================================================

app.get("/prestamos", (req, res) => {
  const sql = `
    SELECT
      p.id,
      p.material_id,
      p.docente_id,
      m.nombre AS material,
      u.nombre AS docente,
      p.fecha_prestamo,
      p.fecha_devolucion
    FROM prestamos p
    JOIN materiales m ON p.material_id = m.id
    JOIN usuarios u ON p.docente_id = u.id
    ORDER BY p.id DESC
  `;

  conexion.query(sql, (err, result) => {
    if (err) {
      return res.status(500).json({
        status: "error",
        mensaje: err.message,
      });
    }

    res.json(result);
  });
});

app.post("/prestamos", (req, res) => {
  const {
    material_id,
    docente_id,
    fecha_prestamo,
  } = req.body;

  const fecha =
    fecha_prestamo ||
    new Date().toISOString().slice(0, 19).replace("T", " ");

  if (!material_id || !docente_id) {
    return res.status(400).json({
      status: "error",
      mensaje: "Se requiere seleccionar material y docente",
    });
  }

  const sql = `
    INSERT INTO prestamos
    (material_id, docente_id, fecha_prestamo)
    VALUES (?, ?, ?)
  `;

  conexion.query(
    sql,
    [material_id, docente_id, fecha],
    (err, result) => {
      if (err) {
        return res.status(500).json({
          status: "error",
          mensaje: err.message,
        });
      }

      res.json({
        status: "ok",
        mensaje: "Préstamo registrado exitosamente",
        id: result.insertId,
      });
    }
  );
});

// =====================================================
// PERMISOS
// =====================================================

app.post("/permisos", (req, res) => {
  const {
    docente_id,
    material_id,
    puede_ver,
    puede_prestar,
    puede_devolver,
  } = req.body;

  const sql = `
    INSERT INTO permisos
    (docente_id, material_id, puede_ver, puede_prestar, puede_devolver)
    VALUES (?, ?, ?, ?, ?)
  `;

  conexion.query(
    sql,
    [
      docente_id,
      material_id,
      puede_ver ?? true,
      puede_prestar ?? true,
      puede_devolver ?? true,
    ],
    (err) => {
      if (err) {
        return res.status(500).json({
          status: "error",
          mensaje: err.message,
        });
      }

      res.json({
        status: "ok",
        mensaje: "Permiso asignado correctamente",
      });
    }
  );
});

// =====================================================
// NOTIFICACIONES
// =====================================================

app.get("/notificaciones/:docente_id", (req, res) => {
  const sql = `
    SELECT
      p.id,
      m.nombre AS material,
      p.fecha_prestamo
    FROM prestamos p
    JOIN materiales m ON p.material_id = m.id
    WHERE p.docente_id = ?
    AND p.fecha_devolucion IS NULL
  `;

  conexion.query(
    sql,
    [req.params.docente_id],
    (err, result) => {
      if (err) {
        return res.status(500).json({
          status: "error",
          mensaje: err.message,
        });
      }

      res.json(result);
    }
  );
});

// =====================================================
// DASHBOARD
// =====================================================

app.get("/dashboard", (req, res) => {
  const sql = `
    SELECT
      (SELECT COUNT(*) FROM materiales) AS total_materiales,
      (SELECT COUNT(*) FROM prestamos
       WHERE fecha_devolucion IS NULL) AS prestados,
      (SELECT COUNT(*) FROM prestamos
       WHERE fecha_devolucion IS NOT NULL) AS devueltos,
      (SELECT COUNT(*) FROM materiales
       WHERE estado = 'dañado') AS danados
  `;

  conexion.query(sql, (err, result) => {
    if (err) {
      return res.status(500).json({
        status: "error",
        mensaje: err.message,
      });
    }

    res.json(result[0]);
  });
});

// =====================================================
// REGISTRO
// =====================================================

app.post("/registro", (req, res) => {
  const {
    nombre,
    correo,
    clave,
    rol,
  } = req.body;

  if (!nombre || !clave) {
    return res.status(400).json({
      status: "error",
      mensaje: "Campos incompletos",
    });
  }

  const sql = `
    INSERT INTO usuarios
    (nombre, correo, clave, rol)
    VALUES (?, ?, ?, ?)
  `;

  conexion.query(
    sql,
    [
      nombre,
      correo,
      clave,
      rol || "maestro",
    ],
    (err, result) => {
      if (err) {
        return res.status(500).json({
          status: "error",
          mensaje: err.message,
        });
      }

      res.json({
        status: "ok",
        mensaje: "Usuario registrado",
        id: result.insertId,
      });
    }
  );
});

// =====================================================
// LOGIN
// =====================================================

app.post("/login", (req, res) => {
  const {
    usuario,
    clave,
  } = req.body;

  if (!usuario || !clave) {
    return res.status(400).json({
      status: "error",
      mensaje: "Usuario y contraseña son requeridos",
    });
  }

  const sql = `
    SELECT *
    FROM usuarios
    WHERE LOWER(nombre) = LOWER(?)
       OR LOWER(correo) = LOWER(?)
  `;

  conexion.query(
    sql,
    [usuario, usuario],
    (err, result) => {
      if (err) {
        return res.status(500).json({
          status: "error",
          mensaje: err.message,
        });
      }

      if (result.length === 0) {
        return res.json({
          status: "error",
          mensaje: "Usuario no encontrado",
        });
      }

      const user = result[0];

      if (user.clave !== clave) {
        return res.json({
          status: "error",
          mensaje: "Contraseña incorrecta",
        });
      }

      const token = jwt.sign(
        {
          id: user.id,
          nombre: user.nombre,
          rol: user.rol,
        },
        SECRET,
        {
          expiresIn: "1h",
        }
      );

      res.json({
        status: "ok",
        token,
        id: user.id,
        nombre: user.nombre,
        rol: user.rol,
        usuario: user.nombre,
      });
    }
  );
});

// =====================================================
// MATERIALES
// =====================================================

app.get("/materiales", (req, res) => {
  conexion.query(
    "SELECT * FROM materiales ORDER BY id DESC",
    (err, results) => {
      if (err) {
        return res.status(500).json({
          status: "error",
          mensaje: err.message,
        });
      }

      res.json(results);
    }
  );
});

app.get("/materiales/:id", (req, res) => {
  conexion.query(
    "SELECT * FROM materiales WHERE id = ?",
    [req.params.id],
    (err, results) => {
      if (err) {
        return res.status(500).json({
          status: "error",
          mensaje: err.message,
        });
      }

      if (results.length === 0) {
        return res.status(404).json({
          status: "error",
          mensaje: "Material no encontrado",
        });
      }

      res.json(results[0]);
    }
  );
});

app.post(
  "/materiales",
  upload.single("foto"),
  (req, res) => {
    const {
      nombre,
      cantidad,
      estado,
      categoria,
    } = req.body;

    const fotoPath = req.file
      ? req.file.filename
      : null;

    const sql = `
      INSERT INTO materiales
      (nombre, cantidad, estado, categoria, foto)
      VALUES (?, ?, ?, ?, ?)
    `;

    conexion.query(
      sql,
      [
        nombre,
        cantidad,
        estado || "Bueno",
        categoria || "Otro",
        fotoPath,
      ],
      (err, result) => {
        if (err) {
          return res.status(500).json({
            status: "error",
            mensaje: err.message,
          });
        }

        const nuevoId = result.insertId;
        const qrFileName = `material_${nuevoId}.png`;

        QRCode.toFile(
          path.join(QRS_DIR, qrFileName),
          String(nuevoId),
          {
            width: 400,
          },
          (qrError) => {
            if (qrError) {
              return res.status(500).json({
                status: "error",
                mensaje: qrError.message,
              });
            }

            conexion.query(
              "UPDATE materiales SET qr = ? WHERE id = ?",
              [qrFileName, nuevoId],
              (updateError) => {
                if (updateError) {
                  return res.status(500).json({
                    status: "error",
                    mensaje: updateError.message,
                  });
                }

                res.json({
                  status: "ok",
                  mensaje: "Material registrado con éxito",
                  id: nuevoId,
                  qr: qrFileName,
                });
              }
            );
          }
        );
      }
    );
  }
);

// =====================================================
// DEVOLVER PRESTAMO
// =====================================================

app.put("/prestamos/devolver/:id", (req, res) => {
  conexion.query(
    "UPDATE prestamos SET fecha_devolucion = NOW() WHERE id = ?",
    [req.params.id],
    (err) => {
      if (err) {
        return res.status(500).json({
          status: "error",
          mensaje: err.message,
        });
      }

      res.json({
        status: "ok",
        mensaje: "Material devuelto",
      });
    }
  );
});

// =====================================================
// ENTREGA POR MATERIAL
// =====================================================

app.put(
  "/prestamos/entrega/:material_id",
  (req, res) => {
    const sqlBuscar = `
      SELECT id
      FROM prestamos
      WHERE material_id = ?
      AND fecha_devolucion IS NULL
      ORDER BY id DESC
      LIMIT 1
    `;

    conexion.query(
      sqlBuscar,
      [req.params.material_id],
      (err, rows) => {
        if (err) {
          return res.status(500).json({
            status: "error",
            mensaje: err.message,
          });
        }

        if (rows.length === 0) {
          return res.json({
            status: "fail",
            mensaje: "Sin préstamos pendientes",
          });
        }

        conexion.query(
          "UPDATE prestamos SET fecha_devolucion = NOW() WHERE id = ?",
          [rows[0].id],
          (err2) => {
            if (err2) {
              return res.status(500).json({
                status: "error",
                mensaje: err2.message,
              });
            }

            res.json({
              status: "ok",
              mensaje: "Entrega registrada correctamente",
            });
          }
        );
      }
    );
  }
);

// =====================================================
// REPORTES
// =====================================================

app.get("/reportes/total", (req, res) => {
  conexion.query(
    "SELECT COUNT(*) AS total FROM prestamos",
    (err, r) => {
      if (err) {
        return res.status(500).json({
          status: "error",
          mensaje: err.message,
        });
      }

      res.json({
        total: r[0].total,
      });
    }
  );
});

app.get("/reportes/pendientes", (req, res) => {
  conexion.query(
    "SELECT COUNT(*) AS pendientes FROM prestamos WHERE fecha_devolucion IS NULL",
    (err, r) => {
      if (err) {
        return res.status(500).json({
          status: "error",
          mensaje: err.message,
        });
      }

      res.json({
        pendientes: r[0].pendientes,
      });
    }
  );
});

app.get("/reportes/devueltos", (req, res) => {
  conexion.query(
    "SELECT COUNT(*) AS devueltos FROM prestamos WHERE fecha_devolucion IS NOT NULL",
    (err, r) => {
      if (err) {
        return res.status(500).json({
          status: "error",
          mensaje: err.message,
        });
      }

      res.json({
        devueltos: r[0].devueltos,
      });
    }
  );
});

// =====================================================
// MANEJO DE ERRORES DE MULTER Y GENERALES
// =====================================================

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({
      status: "error",
      mensaje: err.message,
    });
  }

  if (err) {
    return res.status(400).json({
      status: "error",
      mensaje: err.message,
    });
  }

  next();
});

// =====================================================
// PUERTO RAILWAY
// =====================================================

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Servidor ejecutándose en el puerto ${PORT}`);
});