# StreamLab

Plataforma de streaming para la práctica. Usa Node.js, SQLite, Express, Socket.IO, FFmpeg y OBS Studio.

## Ejecutar en local

Instala Node.js 22.13 o superior y FFmpeg. Desde Git Bash en esta carpeta:

```bash
npm install
cp .env.example .env
npm start
```

Abre [StreamLab](http://localhost:3000), crea una cuenta y entra en **Mi canal**. Si FFmpeg no está en el PATH, indica la ruta a su ejecutable en `FFMPEG_PATH`.

En OBS, abre **Ajustes → Emisión → Personalizado**. Copia el servidor y la clave del panel. Configura H.264 + AAC, 2 500 kbps y fotogramas clave cada 2 s. Agrega una fuente y pulsa **Iniciar transmisión**. Abre el canal desde otro navegador o una ventana privada.

## Verificación

1. Registra dos cuentas y comprueba el inicio y cierre de sesión.
2. Edita título, descripción y categoría. Localiza el canal en Explorar con el filtro.
3. Prueba una clave incorrecta y después la válida. Comprueba el cambio a En vivo y la reproducción.
4. Abre el canal en dos ventanas. Revisa el contador al entrar y salir, envía mensajes y prueba el límite de frecuencia.
5. Sigue el canal con la segunda cuenta, búscalo en Siguiendo y deja de seguirlo.
6. Detén OBS y reproduce la grabación en Transmisiones anteriores. Regenera la clave y comprueba que la anterior se rechaza.
7. Para comparar latencias, usa un cronómetro en OBS. Haz cinco lecturas por configuración con `HLS_TIME=1`, `2` y `4`. Reinicia el servidor al cambiar esta variable. Para probar segmentos de 1 s, usa también fotogramas clave cada 1 s.

## AWS y entrega

Sube el proyecto a tu repositorio de GitHub. Desde Git Bash sigue el manual para crear la instancia EC2 Ubuntu, restringir SSH a tu IP y habilitar HTTP 80 y RTMP 1935. Instala Node.js 22.13+ en la instancia, clona el repositorio y ejecuta `bash deploy/setup-ec2.sh`. Comprueba la URL pública y conecta OBS usando los datos del panel del creador.

Conserva la URL y el repositorio para la revisión. En el reporte de hasta cinco páginas incluye capturas de tu prueba en AWS, prompts, costo real y las respuestas de reflexión. Para estimar transferencia usa `GB = Mbps × 3600 × horas × espectadores / 8000`. Tras la revisión, termina la instancia y captura el estado `terminated`.
