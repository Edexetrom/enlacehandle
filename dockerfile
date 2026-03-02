# Imagen base ligera
FROM node:18-alpine

# Instalamos dependencias para compilar sqlite3
RUN apk add --no-cache python3 make g++

# Directorio de trabajo
WORKDIR /usr/src/app

# Copiar archivos de dependencias
COPY package*.json ./

# Instalar dependencias
RUN npm install

# Copiar el código fuente
COPY . .

# Exponer puerto 3000
EXPOSE 3000

# El archivo credentials.json ya NO es necesario copiarlo si usas variables de entorno.
# Pero si lo tienes y no usas .env, el script lo detectará.

# Comando de inicio
CMD [ "npm", "start" ]