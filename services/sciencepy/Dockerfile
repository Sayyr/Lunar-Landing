FROM python:3.13-slim
WORKDIR /app
COPY services/science/pyproject.toml ./
COPY services/science/src ./src
RUN pip install --no-cache-dir .
EXPOSE 8000
CMD ["uvicorn", "selene_science.app:app", "--host", "0.0.0.0", "--port", "8000"]
