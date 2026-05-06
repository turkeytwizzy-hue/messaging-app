FROM node:20-alpine

WORKDIR /app

# Copy package files and install dependencies
COPY package.json package-lock.json* ./
RUN npm install

# Copy source and migration files
COPY . .

# Expose port and start (migrations run automatically before server)
EXPOSE 3000
CMD ["sh", "-c", "npm run migrate && npm start"]
