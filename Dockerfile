FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY review_desk /app/review_desk
ENV PYTHONUNBUFFERED=1
EXPOSE 8765
CMD ["python", "-m", "review_desk", "--instance", "/instance", "serve", "--host", "0.0.0.0", "--port", "8765"]
