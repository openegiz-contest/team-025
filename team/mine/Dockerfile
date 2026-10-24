FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY constants.py setup_twins.py simulator.py twins.json ./
USER nobody
CMD ["python", "simulator.py"]
