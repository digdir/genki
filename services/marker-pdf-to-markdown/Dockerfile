FROM python:3.13-slim

WORKDIR /app

RUN apt-get update && apt-get install -y \
    libgomp1 \
    libgl1 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt requirements-web.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY download_models.py download_models.py
RUN python download_models.py && rm download_models.py

COPY main.py main.py

RUN mkdir -p /cache

ENV PORT=8080
ENV CACHE_DIR=/cache
ENV PYTHONUNBUFFERED=1

EXPOSE 8080

CMD ["python", "main.py"]
